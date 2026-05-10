import {
	type Agent,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Api, Model } from "@mariozechner/pi-ai";
import { parseWireFrame, useEventStore } from "../store/eventStore";
import { createMessagePortStream } from "../transport/message-port-stream";
import type { WorkspaceProvider } from "../workspace/provider";
import type { InitMessage, WorkerMessage } from "./types";

const STD_INIT_PARAMS = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;

export interface RuntimeOptions {
	models: Model<Api>[];
	defaultModelId: string;
	apiKeys: Record<string, string>;
	systemPrompt?: string;
	workspace: WorkspaceProvider;
	onNotification: (notif: SessionNotification) => void;
	/**
	 * Spawns the agent worker. The host owns the spawn so Vite can resolve
	 * `new URL("./worker.ts", import.meta.url)` against host-local source.
	 */
	workerFactory: () => Worker;
	/**
	 * Optional `MessagePort` already wired to a sandboxed iframe. Hosts under
	 * a strict CSP (MV3 chrome extensions) provide one so the worker can
	 * delegate `unsafe-eval`-bound work (extension factories, `run_script`).
	 * Transferred to the worker via the `init` message.
	 */
	sandboxPort?: MessagePort;
}

export interface AgentRuntime {
	conn: ClientSideConnection;
	worker: Worker;
	dispose: () => void;
}

export async function startAgentRuntime(opts: RuntimeOptions): Promise<AgentRuntime> {
	const worker = opts.workerFactory();

	const channel = new MessageChannel();
	const init: InitMessage = {
		type: "init",
		agentPort: channel.port2,
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		apiKeys: opts.apiKeys,
		// Provider closures don't survive structured clone — wire the discriminated
		// data record. Worker reconstructs a provider via `workspaceProviderFromData`.
		workspace: opts.workspace.toData(),
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		...(opts.sandboxPort !== undefined ? { sandboxPort: opts.sandboxPort } : {}),
	};
	const transfer: Transferable[] = [channel.port2];
	if (opts.sandboxPort !== undefined) transfer.push(opts.sandboxPort);
	worker.postMessage(init, transfer);

	// Push captured events outside React's render cycle so the panel only
	// re-renders when the event arrays change reference.
	const onWorkerMessage = (ev: MessageEvent<unknown>) => {
		const msg = ev.data as WorkerMessage | undefined;
		if (!msg) return;
		if (msg.type === "bodhi-pi-event") {
			useEventStore.getState().pushLifecycle(msg.record);
			return;
		}
		if (msg.type === "bodhi-pi-wire") {
			const parsed = parseWireFrame(msg.line);
			useEventStore.getState().pushWire({
				direction: msg.direction,
				kind: parsed.kind,
				method: parsed.method,
				rpcId: parsed.rpcId,
				payload: msg.line,
				ts: msg.ts,
			});
			return;
		}
	};
	worker.addEventListener("message", onWorkerMessage);

	const { readable, writable } = createMessagePortStream(channel.port1);
	const stream = ndJsonStream(writable, readable);

	const handler: Client = {
		sessionUpdate: async (params) => {
			opts.onNotification(params);
		},
		requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
	};

	const conn = new ClientSideConnection((_agent: Agent): Client => handler, stream);

	await conn.initialize(STD_INIT_PARAMS);

	return {
		conn,
		worker,
		dispose: () => {
			worker.removeEventListener("message", onWorkerMessage);
			worker.terminate();
		},
	};
}
