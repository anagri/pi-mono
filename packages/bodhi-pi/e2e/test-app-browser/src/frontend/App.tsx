import { type Agent, type Client, ClientSideConnection, ndJsonStream, type SessionNotification } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EventEntry, FrameEntry } from "@e2e/app-utils/browser/lib/frame-log";
import { parseSeedFiles } from "@e2e/app-utils/browser/lib/seed-parser";
import { tryHandleSlash } from "@e2e/app-utils/browser/lib/slash-router";
import { bindFsBridge } from "@e2e/app-utils/browser/lib/worker-fs-bridge";
import { WORKSPACE_NAME, WORKSPACE_ROOT } from "@e2e/app-utils/browser/lib/workspace-constants";
import type { WorkerMessage } from "@e2e/app-utils/browser/runtime/types";
import { createMessagePortStream } from "@e2e/app-utils/browser/transport/message-port-stream";

type RootState = "needs-init" | "ready" | "streaming" | "closed" | "error";

interface PageConfig {
	models?: Model<Api>[];
	defaultModelId?: string;
	apiKeys?: Record<string, string>;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	homeDir?: string;
}

const STREAMING_METHODS = new Set(["session/prompt", "session/load", "session/resume"]);

function workerFactory(): Worker {
	return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

export function App() {
	const [state, setState] = useState<RootState>("needs-init");
	const [errorMsg, setErrorMsg] = useState<string>("");
	const [frames, setFrames] = useState<FrameEntry[]>([]);
	const [events, setEvents] = useState<EventEntry[]>([]);
	const [acpInput, setAcpInput] = useState<string>("");
	const seqRef = useRef(0);
	const eventSeqRef = useRef(0);
	const activeSessionRef = useRef<string | null>(null);
	const inFlightStreamingRef = useRef<Set<string>>(new Set());
	const connRef = useRef<ClientSideConnection | null>(null);
	const workerRef = useRef<Worker | null>(null);

	const pushFrame = useCallback((f: Omit<FrameEntry, "seq">) => {
		setFrames((prev) => [...prev, { ...f, seq: prev.length + 1 }]);
		seqRef.current += 1;
	}, []);

	const pushEvent = useCallback((type: string, payload: string) => {
		eventSeqRef.current += 1;
		const seq = eventSeqRef.current;
		setEvents((prev) => [...prev, { seq, type, payload }]);
	}, []);

	useEffect(() => {
		return () => {
			workerRef.current?.terminate();
			workerRef.current = null;
		};
	}, []);

	const recordWireFrame = useCallback(
		(direction: "in" | "out", line: string) => {
			let parsed: { method?: string; id?: string | number; result?: unknown; error?: unknown; params?: unknown };
			try {
				parsed = JSON.parse(line);
			} catch {
				parsed = {};
			}
			const method = typeof parsed.method === "string" ? parsed.method : "";
			const rpcId = parsed.id !== undefined ? String(parsed.id) : "";
			const isNotification = !!parsed.method && parsed.id === undefined;
			const isResponse = parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined);
			const kind: FrameEntry["kind"] = isNotification ? "notification" : isResponse ? "response" : "request";
			pushFrame({
				direction,
				kind,
				method,
				rpcId,
				payload: line,
			});
		},
		[pushFrame],
	);

	const onSetupSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const form = new FormData(e.target as HTMLFormElement);
			const id = String(form.get("user-id") ?? "").trim();
			const email = String(form.get("user-email") ?? "").trim();
			const seed = String(form.get("seed-files") ?? "");
			const configRaw = String(form.get("config") ?? "").trim();
			if (!id) {
				setErrorMsg("user-id is required");
				setState("error");
				return;
			}
			if (!email) {
				setErrorMsg("user-email is required");
				setState("error");
				return;
			}
			let config: PageConfig = {};
			if (configRaw.length > 0) {
				try {
					config = JSON.parse(configRaw) as PageConfig;
				} catch (err) {
					setErrorMsg(`invalid config JSON: ${(err as Error).message}`);
					setState("error");
					return;
				}
			}
			try {
				const seedFiles = parseSeedFiles(seed);
				const worker = workerFactory();
				workerRef.current = worker;
				bindFsBridge(worker);

				// Wait for worker ready before opening ACP. Worker posts
				// "bodhi-pi-ready" once the agent is wired; until then,
				// `initialize` would race the worker's adapter bootstrap.
				const readyPromise = new Promise<void>((resolve, reject) => {
					const onMessage = (ev: MessageEvent<WorkerMessage>) => {
						if (!ev.data) return;
						if (ev.data.type === "bodhi-pi-ready") {
							worker.removeEventListener("message", onMessage);
							resolve();
						} else if (ev.data.type === "bodhi-pi-error") {
							worker.removeEventListener("message", onMessage);
							reject(new Error(ev.data.message));
						}
					};
					worker.addEventListener("message", onMessage);
				});

				worker.addEventListener("message", (ev: MessageEvent<WorkerMessage>) => {
					if (!ev.data) return;
					if (ev.data.type === "bodhi-pi-event") {
						pushEvent(ev.data.record.type, JSON.stringify(ev.data.record));
					}
				});

				const channel = new MessageChannel();
				worker.postMessage(
					{
						type: "init",
						agentPort: channel.port2,
						cwd: WORKSPACE_ROOT,
						dbName: `bodhi-pi-test-${id}`,
						mountName: WORKSPACE_NAME,
						seedFiles,
						models: config.models,
						defaultModelId: config.defaultModelId,
						apiKeys: config.apiKeys,
						systemPrompt: config.systemPrompt,
						appendSystemPrompt: config.appendSystemPrompt,
						homeDir: config.homeDir,
					},
					[channel.port2],
				);

				await readyPromise;

				const { readable, writable } = createMessagePortStream(channel.port1);
				const teedReadable = new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, ctl) {
						const text = new TextDecoder("utf-8").decode(chunk);
						for (const line of text.split("\n")) {
							if (line.trim()) recordWireFrame("in", line);
						}
						ctl.enqueue(chunk);
					},
				});
				const teedWritable = new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, ctl) {
						const text = new TextDecoder("utf-8").decode(chunk);
						for (const line of text.split("\n")) {
							if (line.trim()) recordWireFrame("out", line);
						}
						ctl.enqueue(chunk);
					},
				});
				teedWritable.readable.pipeTo(writable).catch(() => {});
				const stream = ndJsonStream(teedWritable.writable, readable.pipeThrough(teedReadable));

				const client: Client = {
					sessionUpdate: async (_params: SessionNotification) => {
						// Notifications already surface in the frame log via the
						// readable tap; harness reads from there.
					},
					requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
				};
				const conn = new ClientSideConnection((_agent: Agent): Client => client, stream);
				connRef.current = conn;
				setState("ready");
			} catch (err) {
				setErrorMsg((err as Error).message ?? String(err));
				setState("error");
			}
		},
		[pushEvent, recordWireFrame],
	);

	const onAcpSubmit = useCallback(async () => {
		const raw = acpInput;
		setAcpInput("");
		const slashResult = await tryHandleSlash(raw);
		if (slashResult) {
			const synthId = `slash-${seqRef.current + 1}`;
			pushFrame({
				direction: "out",
				kind: "request",
				method: slashResult.method,
				rpcId: synthId,
				payload: JSON.stringify({ jsonrpc: "2.0", id: synthId, method: slashResult.method, params: { input: raw } }),
			});
			pushFrame({
				direction: "in",
				kind: "response",
				method: slashResult.method,
				rpcId: synthId,
				payload: JSON.stringify({ jsonrpc: "2.0", id: synthId, result: slashResult.result }),
			});
			return;
		}
		const conn = connRef.current;
		if (!conn) {
			setErrorMsg("connection not ready");
			setState("error");
			return;
		}
		let body: { id?: string | number; method?: string; params?: unknown };
		try {
			body = JSON.parse(raw);
		} catch (err) {
			pushFrame({
				direction: "in",
				kind: "response",
				method: "_test/parse-error",
				rpcId: "0",
				payload: JSON.stringify({ error: { code: -32700, message: (err as Error).message ?? String(err) } }),
			});
			return;
		}
		const method = String(body.method ?? "");
		const params = body.params as Record<string, unknown> | undefined;
		const isStreaming = STREAMING_METHODS.has(method);
		if (isStreaming) {
			inFlightStreamingRef.current.add(method);
			setState("streaming");
		}
		try {
			// Dispatch by method. Use the typed ACP SDK methods for known ones
			// and `extMethod` for everything else (the bodhi-pi extension space:
			// `_bodhi-pi/kv/*`, `_bodhi-pi/session/*`, etc.).
			// biome-ignore lint/suspicious/noExplicitAny: method dispatch
			const c = conn as any;
			let result: unknown;
			switch (method) {
				case "initialize":
					result = await c.initialize(params);
					break;
				case "session/new":
					result = await c.newSession(params);
					break;
				case "session/load":
					result = await c.loadSession(params);
					break;
				case "session/resume":
					result = await c.resumeSession(params);
					break;
				case "session/list":
					result = await c.listSessions(params);
					break;
				case "session/close":
					result = await c.closeSession(params);
					break;
				case "session/prompt":
					result = await c.prompt(params);
					break;
				case "session/setSessionConfigOption":
					result = await c.setSessionConfigOption(params);
					break;
				case "session/cancel":
					result = await c.cancel(params);
					break;
				default:
					result = await c.extMethod(method, params ?? {});
			}
			// Track active session id from new/load/resume responses.
			if ((method === "session/new" || method === "session/load" || method === "session/resume") && result && typeof result === "object") {
				const r = result as { sessionId?: string };
				if (typeof r.sessionId === "string") activeSessionRef.current = r.sessionId;
				else if (params && typeof params === "object" && typeof (params as { sessionId?: string }).sessionId === "string") {
					activeSessionRef.current = (params as { sessionId: string }).sessionId;
				}
			}
		} catch (err) {
			pushFrame({
				direction: "in",
				kind: "response",
				method: `${method}/error`,
				rpcId: String(body.id ?? "0"),
				payload: JSON.stringify({ error: { message: (err as Error).message ?? String(err) } }),
			});
		} finally {
			if (isStreaming) {
				inFlightStreamingRef.current.delete(method);
				if (inFlightStreamingRef.current.size === 0) setState("ready");
			}
		}
	}, [acpInput, pushFrame]);

	const onCancelClick = useCallback(async () => {
		const sessionId = activeSessionRef.current;
		const conn = connRef.current;
		if (!sessionId || !conn) return;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: cancel signature
			await (conn as any).cancel({ sessionId });
		} catch {
			// best-effort
		}
	}, []);

	return (
		<main data-testid="test-app-root" data-test-state={state}>
			<h1>bodhi-pi test-app-browser</h1>
			{state === "error" && (
				<p data-testid="error-message" role="alert">
					{errorMsg}
				</p>
			)}
			{state === "needs-init" && (
				<form data-testid="setup-form" onSubmit={onSetupSubmit}>
					<label>
						user-id
						<input data-testid="user-id" name="user-id" type="text" required />
					</label>
					<label>
						user-email
						<input data-testid="user-email" name="user-email" type="text" required />
					</label>
					<label>
						seed-files
						<textarea data-testid="seed-files" name="seed-files" rows={8} cols={60} />
					</label>
					<label>
						config
						<textarea data-testid="config" name="config" rows={8} cols={60} />
					</label>
					<button data-testid="setup-submit" type="submit">
						setup
					</button>
				</form>
			)}
			{(state === "ready" || state === "streaming") && (
				<section data-testid="acp-io">
					<p data-testid="workspace-root">{WORKSPACE_ROOT}</p>
					<textarea
						data-testid="acp-input"
						value={acpInput}
						onChange={(e) => setAcpInput(e.target.value)}
						rows={6}
						cols={80}
					/>
					<div>
						<button data-testid="acp-submit" type="button" onClick={onAcpSubmit}>
							submit
						</button>
						<button data-testid="acp-cancel" type="button" onClick={onCancelClick}>
							cancel
						</button>
					</div>
				</section>
			)}
			<section data-testid="frame-log">
				{frames.map((f) => (
					<div
						key={f.seq}
						data-testid="frame"
						data-frame-direction={f.direction}
						data-frame-kind={f.kind}
						data-frame-method={f.method}
						data-frame-rpc-id={f.rpcId}
						data-frame-seq={f.seq}
					>
						<pre>{f.payload}</pre>
					</div>
				))}
			</section>
			<section data-testid="event-log">
				{events.map((ev) => (
					<div key={ev.seq} data-testid="event" data-event-type={ev.type} data-event-seq={ev.seq}>
						<pre>{ev.payload}</pre>
					</div>
				))}
			</section>
		</main>
	);
}
