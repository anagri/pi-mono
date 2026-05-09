import {
	type Agent,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createMessagePortStream } from "@bodhiapp/bodhi-pi-browser";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { WorkspaceProvider } from "../workspace/provider";
import type { InitMessage, WorkerEventMessage } from "./types";

declare global {
	interface Window {
		__bodhiPiEventLog?: WorkerEventMessage["record"][];
	}
}

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
	 * Independent observability toggle. The host (RuntimeProvider) reads
	 * `BootstrapResult.recordEvents` and forwards it here; the worker registers
	 * lifecycle-event handlers iff true.
	 */
	recordEvents?: boolean;
}

export interface AgentRuntime {
	conn: ClientSideConnection;
	worker: Worker;
	dispose: () => void;
}

export async function startAgentRuntime(opts: RuntimeOptions): Promise<AgentRuntime> {
	const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

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
		...(opts.recordEvents ? { recordEvents: true } : {}),
	};
	worker.postMessage(init, [channel.port2]);

	if (opts.recordEvents && typeof window !== "undefined") {
		// Initialize the log array once; specs read from this. Worker posts
		// events as `{ type: "bodhi-pi-event", record }` over the standard
		// worker message channel, NOT the agent MessagePort.
		window.__bodhiPiEventLog = window.__bodhiPiEventLog ?? [];
		const log = window.__bodhiPiEventLog;
		worker.addEventListener("message", (ev: MessageEvent<unknown>) => {
			const msg = ev.data as WorkerEventMessage | undefined;
			if (msg?.type === "bodhi-pi-event") log.push(msg.record);
		});
	}

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
			worker.terminate();
		},
	};
}
