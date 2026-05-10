import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

interface ListResult {
	sessions: { sessionId: string; cwd: string; updatedAt: string }[];
	nextCursor?: string;
}

describe("POST /acp — session/list", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("returns empty list for a fresh user", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const r = await rpc<ListResult>(ts.url, tok, { method: "session/list", params: {} });
		expect(r.result.sessions).toEqual([]);
	});

	it("isolates sessions between tenants", async () => {
		const aliceTok = encodeToken({ id: 1, email: "alice@example.com" });
		const bobTok = encodeToken({ id: 2, email: "bob@example.com" });

		// Alice creates 2 sessions
		const a1 = await rpc<{ sessionId: string }>(ts.url, aliceTok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const a2 = await rpc<{ sessionId: string }>(ts.url, aliceTok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});

		// Bob creates 1 session
		const b1 = await rpc<{ sessionId: string }>(ts.url, bobTok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});

		const aliceList = await rpc<ListResult>(ts.url, aliceTok, { method: "session/list", params: {} });
		const aliceIds = aliceList.result.sessions.map((s) => s.sessionId).sort();
		expect(aliceIds).toEqual([a1.result.sessionId, a2.result.sessionId].sort());

		const bobList = await rpc<ListResult>(ts.url, bobTok, { method: "session/list", params: {} });
		expect(bobList.result.sessions.map((s) => s.sessionId)).toEqual([b1.result.sessionId]);
	});
});
