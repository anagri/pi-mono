import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — _bodhi-pi/session/setName + stats + export", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("setName persists across the per-turn rebuild and surfaces in stats", async () => {
		ts.faux.setResponses([fauxAssistantMessage("first reply")]);
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;
		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "first turn" }] },
		});

		const setName = await rpc<{ ok: true; name: string }>(ts.url, tok, {
			method: "_bodhi-pi/session/setName",
			params: { sessionId, name: "my-fork" },
		});
		expect(setName.result.name).toBe("my-fork");

		const stats = await rpc<{
			messageCount: number;
			toolCallCount: number;
			leafId: string;
			name?: string;
		}>(ts.url, tok, {
			method: "_bodhi-pi/session/stats",
			params: { sessionId },
		});
		expect(stats.result.name).toBe("my-fork");
		expect(stats.result.messageCount).toBeGreaterThanOrEqual(2);
	});

	it("export returns JSONL with header + entries", async () => {
		ts.faux.setResponses([fauxAssistantMessage("first reply")]);
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;
		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "first turn" }] },
		});

		const result = await rpc<{ format: string; content: string }>(ts.url, tok, {
			method: "_bodhi-pi/session/export",
			params: { sessionId },
		});
		expect(result.result.format).toBe("jsonl");
		const lines = result.result.content.split("\n").filter((l) => l.length > 0);
		const header = JSON.parse(lines[0]) as { type: string; id: string };
		expect(header.type).toBe("session");
		expect(header.id).toBe(sessionId);
	});

	it("setName rejects unloaded sessions", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		await expect(
			rpc(ts.url, tok, {
				method: "_bodhi-pi/session/setName",
				params: { sessionId: "missing", name: "x" },
			}),
		).rejects.toThrow(/RPC error/);
	});
});
