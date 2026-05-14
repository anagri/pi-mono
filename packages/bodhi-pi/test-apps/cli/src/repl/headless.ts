import readline from "node:readline";
import {
	type Agent,
	AgentSideConnection,
	type AnyMessage,
	type Client,
	ClientSideConnection,
	type Stream,
} from "@agentclientprotocol/sdk";
import { type createBodhiPiAgent, createBodhiPiClient, type SessionStore } from "@bodhiapp/bodhi-pi";

const INIT_PARAMS = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;

export interface HeadlessOptions {
	factory: ReturnType<typeof createBodhiPiAgent>;
	cwd: string;
	sessionStore: SessionStore;
}

/**
 * Headless tagged-REPL mode. Each line on stdin is a user prompt; agent text
 * for that turn is emitted as a single `<response>…</response>` block on
 * stdout. No chalk, no decorations. Used by the cli-headless e2e bucket to
 * exercise user-facing chat without driving raw ACP frames.
 *
 * Slash commands are not interpreted locally — they are forwarded to the agent
 * as prompts. For built-in REPL commands like `/model`, drive the equivalent
 * via raw ACP in `--rpc` mode instead.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<void> {
	const a2c = new TransformStream<AnyMessage, AnyMessage>();
	const c2a = new TransformStream<AnyMessage, AnyMessage>();
	const agentStream: Stream = { readable: c2a.readable, writable: a2c.writable };
	const clientStream: Stream = { readable: a2c.readable, writable: c2a.writable };

	const agentConn = new AgentSideConnection(opts.factory, agentStream);
	void agentConn;

	let turnText = "";
	const clientConn = new ClientSideConnection(
		(_agent: Agent): Client => ({
			sessionUpdate: async (params) => {
				const update = params.update as Record<string, unknown>;
				if (update.sessionUpdate === "agent_message_chunk") {
					const content = update.content as { type: string; text?: string };
					if (content?.type === "text" && content.text) turnText += content.text;
				}
			},
			requestPermission: async () => ({ outcome: { outcome: "approved" } }),
		}),
		clientStream,
	);

	await clientConn.initialize(INIT_PARAMS);
	const bodhiClient = createBodhiPiClient(clientConn, { cwd: opts.cwd });
	const created = await bodhiClient.newSession({ cwd: opts.cwd, mcpServers: [] });

	const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

	for await (const rawLine of rl) {
		const line = rawLine.trim();
		if (!line) continue;
		turnText = "";
		try {
			await bodhiClient.prompt(line, { sessionId: created.sessionId });
			process.stdout.write(`<response>\n${turnText}\n</response>\n`);
		} catch (err) {
			process.stdout.write(`<response>\n[error] ${String(err)}\n</response>\n`);
		}
	}

	rl.close();
	process.exit(0);
}
