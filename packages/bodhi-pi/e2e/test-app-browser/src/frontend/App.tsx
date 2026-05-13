import { useCallback, useRef, useState } from "react";
import type { EventEntry, FrameEntry } from "./lib/frame-log";
import { parseSeedFiles } from "./lib/seed-parser";
import { tryHandleSlash } from "./lib/slash-router";
import { mountWorkspace, WORKSPACE_ROOT } from "./lib/workspace-mount";

type RootState = "needs-init" | "ready" | "streaming" | "closed" | "error";

interface SetupData {
	userId: string;
	userEmail: string;
}

export function App() {
	const [state, setState] = useState<RootState>("needs-init");
	const [errorMsg, setErrorMsg] = useState<string>("");
	const [setupData, setSetupData] = useState<SetupData | null>(null);
	const [frames, setFrames] = useState<FrameEntry[]>([]);
	const [events] = useState<EventEntry[]>([]);
	const [acpInput, setAcpInput] = useState<string>("");
	const seqRef = useRef(0);
	const activeSessionRef = useRef<string | null>(null);

	const nextSeq = () => {
		seqRef.current += 1;
		return seqRef.current;
	};

	const pushFrame = useCallback((f: Omit<FrameEntry, "seq">) => {
		setFrames((prev) => [...prev, { ...f, seq: prev.length + 1 }]);
	}, []);

	const onSetupSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			const form = new FormData(e.target as HTMLFormElement);
			const id = String(form.get("user-id") ?? "").trim();
			const email = String(form.get("user-email") ?? "").trim();
			const seed = String(form.get("seed-files") ?? "");
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
			try {
				const seedFiles = parseSeedFiles(seed);
				await mountWorkspace(seedFiles);
				setSetupData({ userId: id, userEmail: email });
				setState("ready");
			} catch (err) {
				setErrorMsg((err as Error).message ?? String(err));
				setState("error");
			}
		},
		[],
	);

	const onAcpSubmit = useCallback(async () => {
		const raw = acpInput;
		setAcpInput("");
		const slashResult = await tryHandleSlash(raw);
		if (slashResult) {
			const synthId = `slash-${nextSeq()}`;
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
		const rpcId = String(body.id ?? "0");
		const method = String(body.method ?? "");
		pushFrame({
			direction: "out",
			kind: "request",
			method,
			rpcId,
			payload: JSON.stringify(body),
		});
		// Phase 2: echo handler — replaced by real worker dispatch in Phase 3.
		const echoResult = { echo: body.params ?? null };
		pushFrame({
			direction: "in",
			kind: "response",
			method,
			rpcId,
			payload: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: echoResult }),
		});
		if (method === "session/new" || method === "session/load" || method === "session/resume") {
			const params = body.params as { sessionId?: string } | undefined;
			if (params?.sessionId) activeSessionRef.current = params.sessionId;
			else activeSessionRef.current = `echo-session-${nextSeq()}`;
		}
	}, [acpInput, pushFrame]);

	const onCancelClick = useCallback(() => {
		const sessionId = activeSessionRef.current;
		if (!sessionId) return;
		const rpcId = `cancel-${nextSeq()}`;
		pushFrame({
			direction: "out",
			kind: "notification",
			method: "session/cancel",
			rpcId,
			payload: JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }),
		});
	}, [pushFrame]);

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
					<button data-testid="setup-submit" type="submit">
						setup
					</button>
				</form>
			)}
			{(state === "ready" || state === "streaming") && (
				<section data-testid="acp-io">
					<p data-testid="workspace-root">{WORKSPACE_ROOT}</p>
					<p data-testid="user-info">
						{setupData?.userId} / {setupData?.userEmail}
					</p>
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
