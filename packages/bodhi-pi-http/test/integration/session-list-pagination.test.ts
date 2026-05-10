import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

interface ListResult {
	sessions: { sessionId: string; cwd: string; updatedAt: string }[];
	nextCursor?: string;
}

describe("POST /acp — session/list pagination", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("walks the cursor chain to surface every session past PAGE_SIZE", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created: string[] = [];
		for (let i = 0; i < 60; i++) {
			const r = await rpc<{ sessionId: string }>(ts.url, tok, {
				method: "session/new",
				params: { cwd: ts.dataDir, mcpServers: [] },
			});
			created.push(r.result.sessionId);
		}

		const seen = new Set<string>();
		let cursor: string | undefined;
		let pages = 0;
		do {
			const r = await rpc<ListResult>(ts.url, tok, {
				method: "session/list",
				params: cursor ? { cursor } : {},
			});
			for (const s of r.result.sessions) seen.add(s.sessionId);
			cursor = r.result.nextCursor;
			pages++;
		} while (cursor);

		expect(seen.size).toBe(60);
		expect(pages).toBeGreaterThanOrEqual(2);
	});
});
