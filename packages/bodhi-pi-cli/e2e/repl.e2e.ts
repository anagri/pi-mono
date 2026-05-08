import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type Agent,
	AgentSideConnection,
	type AnyMessage,
	type Client,
	ClientSideConnection,
	type SessionNotification,
	type Stream,
} from "@agentclientprotocol/sdk";
import { createBodhiPiAgent, createInMemoryFilesystem, createInMemorySessionStore } from "@bodhiapp/bodhi-pi";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

function createInProcessPair(
	toAgent: (conn: AgentSideConnection) => Agent,
	toClient: (agent: Agent) => Client,
): { clientConn: ClientSideConnection } {
	const a2c = new TransformStream<AnyMessage, AnyMessage>();
	const c2a = new TransformStream<AnyMessage, AnyMessage>();
	const agentStream: Stream = { readable: c2a.readable, writable: a2c.writable };
	const clientStream: Stream = { readable: a2c.readable, writable: c2a.writable };
	const agentConn = new AgentSideConnection(toAgent, agentStream);
	void agentConn;
	const clientConn = new ClientSideConnection(toClient, clientStream);
	return { clientConn };
}

let tmpDb: string;

beforeEach(() => {
	tmpDb = path.join(os.tmpdir(), `repl-e2e-${Date.now()}.db`);
});

afterEach(() => {
	for (const suffix of ["", "-wal", "-shm"]) {
		try {
			fs.unlinkSync(tmpDb + suffix);
		} catch {
			// ignore
		}
	}
});

test("bodhi-pi sends agent_message_chunk and returns end_turn (gpt-5-mini)", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const notifications: SessionNotification[] = [];

	const { clientConn } = createInProcessPair(
		createBodhiPiAgent({
			models: [model],
			defaultModelId: model.id,
			getApiKey: (p) => (p === "openai" ? OPENAI_KEY : undefined),
			sessionStore: createInMemorySessionStore(),
			filesystem: createInMemoryFilesystem(),
		}),
		(_agent) => ({
			sessionUpdate: async (params) => {
				notifications.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "approved" } }),
		}),
	);

	await clientConn.initialize({
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
	});
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	const result = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with exactly one word: hello" }],
	});

	expect(result.stopReason).toBe("end_turn");
	const chunks = notifications.filter((n) => n.update.sessionUpdate === "agent_message_chunk");
	expect(chunks.length).toBeGreaterThanOrEqual(1);
});
