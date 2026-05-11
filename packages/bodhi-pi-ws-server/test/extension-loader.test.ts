import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client, SessionNotification } from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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

const EXT_SOURCE = `export default function (pi) {
	pi.on("tool_result", () => {
		// no-op; we only assert the loader picked the file up.
	});
};`;

describe("per-connection extension loader", () => {
	let workspace: string;
	let ts: TestServer;

	afterEach(async () => {
		if (ts) await ts.cleanup();
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	});

	it("loads .bodhi-pi/extensions/*.mjs from the workspace at connect time without throwing", async () => {
		workspace = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-ws-ext-"));
		mkdirSync(path.join(workspace, ".bodhi-pi", "extensions"), { recursive: true });
		writeFileSync(path.join(workspace, ".bodhi-pi", "extensions", "noop.mjs"), EXT_SOURCE, "utf8");

		ts = await startTestServer({ workspaceOverride: workspace });
		ts.faux.setResponses([fauxAssistantMessage("ok")]);

		const { ws, conn } = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });
		await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		// newSession must succeed — proves the extension factory loaded + ran without throwing.
		const ns = await conn.newSession({ cwd: workspace, mcpServers: [] });
		expect(ns.sessionId).toBeTruthy();

		ws.close();
	});

	it("a malformed extension is logged and skipped; peer sessions still boot", async () => {
		workspace = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-ws-ext-bad-"));
		mkdirSync(path.join(workspace, ".bodhi-pi", "extensions"), { recursive: true });
		writeFileSync(
			path.join(workspace, ".bodhi-pi", "extensions", "broken.mjs"),
			"this is not valid javascript {{{",
			"utf8",
		);

		ts = await startTestServer({ workspaceOverride: workspace });
		ts.faux.setResponses([fauxAssistantMessage("ok")]);

		const { ws, conn } = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });
		await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const ns = await conn.newSession({ cwd: workspace, mcpServers: [] });
		expect(ns.sessionId).toBeTruthy();

		ws.close();
	});

	it("no extensions dir present → newSession still works", async () => {
		workspace = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-ws-ext-empty-"));

		ts = await startTestServer({ workspaceOverride: workspace });
		ts.faux.setResponses([fauxAssistantMessage("ok")]);

		const { ws, conn } = await connect(ts.server.port(), { id: 1, email: "alice@example.com" });
		await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const ns = await conn.newSession({ cwd: workspace, mcpServers: [] });
		expect(ns.sessionId).toBeTruthy();

		ws.close();
	});
});
