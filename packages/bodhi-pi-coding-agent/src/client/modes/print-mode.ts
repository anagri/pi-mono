import type { Agent, AnyMessage } from "@agentclientprotocol/sdk";
import { AgentSideConnection, type Client, ClientSideConnection, type Stream } from "@agentclientprotocol/sdk";
import { type createBodhiPiAgent, createBodhiPiClient, type SessionStore } from "@bodhiapp/bodhi-pi";
import { createRenderer } from "../render.js";

const INIT_PARAMS = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;

export interface PrintModeOptions {
	factory: ReturnType<typeof createBodhiPiAgent>;
	cwd: string;
	sessionStore: SessionStore;
	initialMessage?: string;
}

export async function runPrintMode(opts: PrintModeOptions): Promise<void> {
	const renderer = createRenderer();

	const a2c = new TransformStream<AnyMessage, AnyMessage>();
	const c2a = new TransformStream<AnyMessage, AnyMessage>();
	const agentStream: Stream = { readable: c2a.readable, writable: a2c.writable };
	const clientStream: Stream = { readable: a2c.readable, writable: c2a.writable };

	const agentConn = new AgentSideConnection(opts.factory, agentStream);
	void agentConn;

	const clientConn = new ClientSideConnection(
		(_agent: Agent): Client => ({
			sessionUpdate: async (params) => {
				renderer.onNotification(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "approved" } }),
		}),
		clientStream,
	);

	await clientConn.initialize(INIT_PARAMS);
	const bodhiClient = createBodhiPiClient(clientConn, { cwd: opts.cwd });
	const created = await bodhiClient.newSession({ cwd: opts.cwd, mcpServers: [] });

	if (opts.initialMessage) {
		try {
			const result = await bodhiClient.prompt(opts.initialMessage, { sessionId: created.sessionId });
			renderer.flush();
			process.stderr.write(`[${result.stopReason}]\n`);
		} catch (err) {
			renderer.flush();
			process.stderr.write(`error: ${String(err)}\n`);
		}
	}

	process.exit(0);
}
