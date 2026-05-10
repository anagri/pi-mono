import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — _bodhi-pi/session/delete", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("removes the session from list", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});

		await rpc(ts.url, tok, {
			method: "_bodhi-pi/session/delete",
			params: { sessionId: created.result.sessionId },
		});

		const list = await rpc<{ sessions: { sessionId: string }[] }>(ts.url, tok, {
			method: "session/list",
			params: {},
		});
		expect(list.result.sessions).toEqual([]);
	});

	it("rejects deletion of another tenant's session", async () => {
		const aliceTok = encodeToken({ id: 1, email: "alice@example.com" });
		const bobTok = encodeToken({ id: 2, email: "bob@example.com" });

		const aliceSession = await rpc<{ sessionId: string }>(ts.url, aliceTok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});

		await expect(
			rpc(ts.url, bobTok, {
				method: "_bodhi-pi/session/delete",
				params: { sessionId: aliceSession.result.sessionId },
			}),
		).rejects.toThrow(/RPC error/);
	});
});
