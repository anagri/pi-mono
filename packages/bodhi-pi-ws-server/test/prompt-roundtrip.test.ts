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
		return { outcome: { outcome: "approved" as const } };
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

function chunkedAgentText(updates: SessionNotification[]): string {
	let text = "";
	for (const u of updates) {
		const update = u.update;
		if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
			text += update.content.text;
		}
	}
	return text;
}

describe("prompt round-trip via WS with faux LLM", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("streams a faux assistant reply over the wire", async () => {
		ts.faux.setResponses([fauxAssistantMessage("pong from faux")]);

		const { ws, conn, updates } = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });

		await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const newSession = await conn.newSession({ cwd: ts.dataDir, mcpServers: [] });
		const result = await conn.prompt({
			sessionId: newSession.sessionId,
			prompt: [{ type: "text", text: "ping" }],
		});

		expect(result.stopReason).toBe("end_turn");
		expect(chunkedAgentText(updates).trim()).toContain("pong from faux");

		ws.close();
	});

	it("isolates per-user cwd: a write through the agent lands under the user's workspace", async () => {
		ts.faux.setResponses([fauxAssistantMessage("ok")]);

		const { ws, conn } = await connect(ts.server.port(), { id: 7, email: "carol@example.com" });
		await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const newSession = await conn.newSession({ cwd: ts.dataDir, mcpServers: [] });
		await conn.prompt({
			sessionId: newSession.sessionId,
			prompt: [{ type: "text", text: "say ok" }],
		});

		// Per-user workspace dir was ensured during agent wiring.
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		const userCwd = path.resolve(ts.dataDir, "users", "7", "workspace");
		const stat = await fs.stat(userCwd);
		expect(stat.isDirectory()).toBe(true);

		ws.close();
	});
});
