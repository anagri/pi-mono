import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — session/close", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("returns {} and leaves the session in the store (per ACP semantics)", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		const closed = await rpc(ts.url, tok, {
			method: "session/close",
			params: { sessionId },
		});
		expect(closed.result).toEqual({});

		// Closed session must still be discoverable via session/list — close drops
		// in-memory runtime state but does not delete the persisted record.
		const list = await rpc<{ sessions: { sessionId: string }[] }>(ts.url, tok, {
			method: "session/list",
			params: {},
		});
		expect(list.result.sessions.map((s) => s.sessionId)).toContain(sessionId);
	});
});
