import {
	type Agent,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { createMessagePortStream } from "@bodhiapp/bodhi-pi-browser";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { WorkspaceConfig } from "../workspace/types";
import type { InitMessage } from "./types";

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
	workspace: WorkspaceConfig;
	onNotification: (notif: SessionNotification) => void;
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
		workspace: opts.workspace,
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
	};
	worker.postMessage(init, [channel.port2]);

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
