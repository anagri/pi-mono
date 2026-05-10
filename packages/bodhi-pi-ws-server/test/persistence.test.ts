import type { Client, SessionNotification } from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { encodeToken } from "../src/auth/token.js";
import { SUBPROTOCOL } from "../src/auth/upgrade.js";
import { wsToStream } from "../src/transport/ws-stream.js";
import { startTestServer, type TestServer } from "./helpers/test-server.js";

class CapturingClient implements Client {
	constructor(public readonly updates: SessionNotification[]) {}
	async requestPermission() {
		return { outcome: { outcome: "cancelled" as const } };
	}
	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}
	async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {}
}

async function connect(port: number, user: { id: number; email: string }) {
	const token = encodeToken(user);
	const ws = new WebSocket(`ws://localhost:${port}/agent`, [SUBPROTOCOL, `bearer.${token}`]);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	const stream = wsToStream(ws as unknown as WebSocket);
	const acpStream = ndJsonStream(stream.writable, stream.readable);
	const updates: SessionNotification[] = [];
	const conn = new ClientSideConnection(() => new CapturingClient(updates), acpStream);
	return { ws, conn, updates };
}

describe("persistence across reconnect + multi-tenant isolation over WS", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("a session created by Alice cannot be loaded by Bob", async () => {
		ts.faux.setResponses([fauxAssistantMessage("hello")]);

		const alice = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });
		await alice.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const newSession = await alice.conn.newSession({ cwd: ts.dataDir, mcpServers: [] });
		await alice.conn.prompt({
			sessionId: newSession.sessionId,
			prompt: [{ type: "text", text: "hi" }],
		});
		alice.ws.close();

		const bob = await connect(ts.server.port(), { id: 2, email: "bob@example.com" });
		await bob.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });

		// session/load via the SDK client invokes the optional method by name
		await expect(
			(bob.conn as unknown as { loadSession: (params: unknown) => Promise<unknown> }).loadSession({
				sessionId: newSession.sessionId,
				cwd: ts.dataDir,
				mcpServers: [],
			}),
		).rejects.toThrow();

		bob.ws.close();
	});

	it("Alice can list only her own sessions", async () => {
		ts.faux.setResponses([fauxAssistantMessage("ack-a"), fauxAssistantMessage("ack-b")]);

		const alice = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });
		await alice.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const aliceSession = await alice.conn.newSession({ cwd: ts.dataDir, mcpServers: [] });
		await alice.conn.prompt({
			sessionId: aliceSession.sessionId,
			prompt: [{ type: "text", text: "hi from alice" }],
		});
		alice.ws.close();

		const bob = await connect(ts.server.port(), { id: 2, email: "bob@example.com" });
		await bob.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const bobSession = await bob.conn.newSession({ cwd: ts.dataDir, mcpServers: [] });
		await bob.conn.prompt({
			sessionId: bobSession.sessionId,
			prompt: [{ type: "text", text: "hi from bob" }],
		});

		const bobList = await (
			bob.conn as unknown as {
				listSessions: (p: object) => Promise<{ sessions: { sessionId: string }[] }>;
			}
		).listSessions({});
		expect(bobList.sessions.map((s) => s.sessionId)).toEqual([bobSession.sessionId]);

		bob.ws.close();

		const aliceAgain = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });
		await aliceAgain.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const aliceList = await (
			aliceAgain.conn as unknown as {
				listSessions: (p: object) => Promise<{ sessions: { sessionId: string }[] }>;
			}
		).listSessions({});
		expect(aliceList.sessions.map((s) => s.sessionId)).toEqual([aliceSession.sessionId]);
		aliceAgain.ws.close();
	});

	it("reconnecting Alice can session/load and replay history", async () => {
		ts.faux.setResponses([fauxAssistantMessage("first turn answer")]);

		const alice = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });
		await alice.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const newSession = await alice.conn.newSession({ cwd: ts.dataDir, mcpServers: [] });
		await alice.conn.prompt({
			sessionId: newSession.sessionId,
			prompt: [{ type: "text", text: "hello" }],
		});
		alice.ws.close();

		const aliceAgain = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });
		await aliceAgain.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		await (
			aliceAgain.conn as unknown as {
				loadSession: (p: object) => Promise<unknown>;
			}
		).loadSession({ sessionId: newSession.sessionId, cwd: ts.dataDir, mcpServers: [] });

		// loadSession streams history via sessionUpdate notifications. We expect at least
		// one user_message_chunk and one agent_message_chunk for the previous turn.
		const kinds = aliceAgain.updates.map((u) => (u.update as { sessionUpdate?: string }).sessionUpdate);
		expect(kinds).toContain("user_message_chunk");
		expect(kinds).toContain("agent_message_chunk");

		aliceAgain.ws.close();
	});
});
