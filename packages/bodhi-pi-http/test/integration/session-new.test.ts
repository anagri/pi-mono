import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — session/new", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("creates a session and returns sessionId", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		await rpc(ts.url, tok, { method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		expect(created.result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("ensures the per-user workspace directory exists", async () => {
		const tok = encodeToken({ id: 7, email: "carol@example.com" });
		await rpc(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const userCwd = path.resolve(ts.dataDir, "users", "7", "workspace");
		expect(fs.existsSync(userCwd)).toBe(true);
		expect(fs.statSync(userCwd).isDirectory()).toBe(true);
	});
});
