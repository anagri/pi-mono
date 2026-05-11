import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client, SessionNotification } from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
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

describe("--workspace override (single-tenant fixture mode)", () => {
	let workspace: string;
	let ts: TestServer;

	beforeEach(async () => {
		workspace = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-ws-fixture-"));
		// Seed a project command into the workspace.
		mkdirSync(path.join(workspace, ".bodhi-pi", "commands"), { recursive: true });
		writeFileSync(path.join(workspace, ".bodhi-pi", "commands", "demo.md"), "Hello from $1\n", "utf8");
		ts = await startTestServer({ workspaceOverride: workspace });
	});

	afterEach(async () => {
		await ts.cleanup();
		rmSync(workspace, { recursive: true, force: true });
	});

	it("advertises the project command via available_commands_update", async () => {
		ts.faux.setResponses([fauxAssistantMessage("ok")]);

		const { ws, conn, updates } = await connect(ts.server.port(), { id: 99, email: "tester@example.com" });
		await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		await conn.newSession({ cwd: workspace, mcpServers: [] });

		const commandUpdates = updates.filter(
			(u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "available_commands_update",
		);
		expect(commandUpdates.length).toBeGreaterThan(0);
		const last = commandUpdates[commandUpdates.length - 1];
		const commands = (last.update as { availableCommands: { name: string }[] }).availableCommands;
		expect(commands.some((c) => c.name === "demo")).toBe(true);

		ws.close();
	});

	it("two users connecting simultaneously share the same workspace contents", async () => {
		ts.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);

		const alice = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });
		await alice.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		await alice.conn.newSession({ cwd: workspace, mcpServers: [] });

		const bob = await connect(ts.server.port(), { id: 2, email: "bob@example.com" });
		await bob.conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		await bob.conn.newSession({ cwd: workspace, mcpServers: [] });

		const aliceCmds = alice.updates.filter(
			(u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "available_commands_update",
		);
		const bobCmds = bob.updates.filter(
			(u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "available_commands_update",
		);
		const aliceNames = (
			aliceCmds[aliceCmds.length - 1].update as { availableCommands: { name: string }[] }
		).availableCommands.map((c) => c.name);
		const bobNames = (
			bobCmds[bobCmds.length - 1].update as { availableCommands: { name: string }[] }
		).availableCommands.map((c) => c.name);
		expect(aliceNames).toContain("demo");
		expect(bobNames).toContain("demo");

		alice.ws.close();
		bob.ws.close();
	});
});
