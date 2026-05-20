import { type Agent, type Client, ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createMessagePortStream } from "@bodhiapp/bodhi-pi-test-app-utils/message-port-stream";
import { parseSeedFiles } from "@bodhiapp/bodhi-pi-test-app-utils/seed-parser";
import type {
	ConnectCallbacks,
	ConnectResult,
	SetupFormValues,
	TransportAdapter,
} from "@bodhiapp/bodhi-pi-test-app-utils/transport-types";
import type { WorkerMessage } from "@bodhiapp/bodhi-pi-test-app-utils/worker-message-types";
import type { Api, Model } from "@earendil-works/pi-ai";
import { bindFsBridge } from "../lib/worker-fs-bridge.ts";
import { WORKSPACE_NAME, WORKSPACE_ROOT } from "../lib/workspace-constants.ts";

interface PageConfig {
	models?: Model<Api>[];
	defaultModelId?: string;
	apiKeys?: Record<string, string>;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	homeDir?: string;
}

export interface CreateTransportAdapterOptions {
	/** Per-workspace worker factory. `new URL("./worker.ts", import.meta.url)` must resolve in the caller's module. */
	workerFactory: () => Worker;
	/**
	 * Optional sandbox port factory for MV3 contexts where the worker realm
	 * forbids unsafe-eval. Returns a MessagePort that is `postMessage`'d to
	 * the worker as `sandboxPort` and added to the transferables list.
	 */
	createSandboxPort?: () => Promise<MessagePort>;
}

export function createTransportAdapter(opts: CreateTransportAdapterOptions): TransportAdapter {
	const { workerFactory, createSandboxPort } = opts;
	let worker: Worker | null = null;
	return {
		async connect(values: SetupFormValues, callbacks: ConnectCallbacks): Promise<ConnectResult> {
			let config: PageConfig = {};
			if (values.configRaw.length > 0) {
				config = JSON.parse(values.configRaw) as PageConfig;
			}
			const seedFiles = parseSeedFiles(values.seed);

			const sandboxPort = await createSandboxPort?.();

			worker?.terminate();
			worker = workerFactory();
			const w = worker;
			bindFsBridge(w);

			const readyPromise = new Promise<void>((resolve, reject) => {
				const onMessage = (ev: MessageEvent<WorkerMessage>) => {
					if (!ev.data) return;
					if (ev.data.type === "bodhi-pi-ready") {
						w.removeEventListener("message", onMessage);
						resolve();
					} else if (ev.data.type === "bodhi-pi-error") {
						w.removeEventListener("message", onMessage);
						reject(new Error(ev.data.message));
					}
				};
				w.addEventListener("message", onMessage);
			});

			w.addEventListener("message", (ev: MessageEvent<WorkerMessage>) => {
				if (!ev.data) return;
				if (ev.data.type === "bodhi-pi-event") {
					callbacks.onEvent(ev.data.record.type, JSON.stringify(ev.data.record));
				}
			});

			const channel = new MessageChannel();
			const initPayload = {
				type: "init" as const,
				agentPort: channel.port2,
				cwd: WORKSPACE_ROOT,
				dbName: `bodhi-pi-test-${values.userId}`,
				mountName: WORKSPACE_NAME,
				seedFiles,
				models: config.models,
				defaultModelId: config.defaultModelId,
				apiKeys: config.apiKeys,
				systemPrompt: config.systemPrompt,
				appendSystemPrompt: config.appendSystemPrompt,
				homeDir: config.homeDir,
				...(sandboxPort ? { sandboxPort } : {}),
			};
			const transferables: Transferable[] = sandboxPort ? [channel.port2, sandboxPort] : [channel.port2];
			w.postMessage(initPayload, transferables);

			await readyPromise;

			const { readable, writable } = createMessagePortStream(channel.port1);
			const teedReadable = new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, ctl) {
					tapLines(chunk, "in", callbacks.onFrame);
					ctl.enqueue(chunk);
				},
			});
			const teedWritable = new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, ctl) {
					tapLines(chunk, "out", callbacks.onFrame);
					ctl.enqueue(chunk);
				},
			});
			teedWritable.readable.pipeTo(writable).catch(() => {});
			const stream = ndJsonStream(teedWritable.writable, readable.pipeThrough(teedReadable));

			const client: Client = {
				sessionUpdate: async (params) => {
					callbacks.onSessionUpdate(params);
				},
				requestPermission: async (params) =>
					callbacks.onPermissionRequest
						? callbacks.onPermissionRequest(params)
						: { outcome: { outcome: "cancelled" } },
			};
			const conn = new ClientSideConnection((_agent: Agent): Client => client, stream);

			return { conn, workspaceRoot: WORKSPACE_ROOT, cwd: WORKSPACE_ROOT };
		},
		cleanup() {
			worker?.terminate();
			worker = null;
		},
	};
}

function tapLines(chunk: Uint8Array, direction: "in" | "out", onFrame: ConnectCallbacks["onFrame"]): void {
	const text = new TextDecoder("utf-8").decode(chunk);
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: { method?: string; id?: string | number; result?: unknown; error?: unknown };
		try {
			parsed = JSON.parse(line);
		} catch {
			parsed = {};
		}
		const method = typeof parsed.method === "string" ? parsed.method : "";
		const rpcId = parsed.id !== undefined ? String(parsed.id) : "";
		const isNotification = !!parsed.method && parsed.id === undefined;
		const isResponse = parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined);
		const kind: "request" | "response" | "notification" = isNotification
			? "notification"
			: isResponse
				? "response"
				: "request";
		onFrame({ direction, kind, method, rpcId, payload: line });
	}
}
