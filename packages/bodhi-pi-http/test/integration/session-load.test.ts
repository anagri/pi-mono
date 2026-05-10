import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — session/load (history replay over SSE)", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("replays prior user + assistant turns as session/update notifications", async () => {
		ts.faux.setResponses([fauxAssistantMessage("first turn answer")]);
		const tok = encodeToken({ id: 1, email: "alice@example.com" });

		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;
		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
		});

		// Fresh HTTP request; agent built fresh and asked to load history.
		const load = await ssePrompt(ts.url, tok, {
			method: "session/load",
			params: { sessionId, cwd: ts.dataDir, mcpServers: [] },
		});

		expect(load.final.error).toBeUndefined();

		const updateKinds = load.notifications
			.filter((n) => n.method === "session/update")
			.map((n) => (n.params as { update: { sessionUpdate: string } }).update.sessionUpdate);

		expect(updateKinds).toContain("user_message_chunk");
		expect(updateKinds).toContain("agent_message_chunk");
	});

	it("rejects load of another tenant's session", async () => {
		ts.faux.setResponses([fauxAssistantMessage("ok")]);
		const aliceTok = encodeToken({ id: 1, email: "alice@example.com" });
		const bobTok = encodeToken({ id: 2, email: "bob@example.com" });

		const aliceSession = await rpc<{ sessionId: string }>(ts.url, aliceTok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		await ssePrompt(ts.url, aliceTok, {
			method: "session/prompt",
			params: { sessionId: aliceSession.result.sessionId, prompt: [{ type: "text", text: "alice" }] },
		});

		const load = await ssePrompt(ts.url, bobTok, {
			method: "session/load",
			params: { sessionId: aliceSession.result.sessionId, cwd: ts.dataDir, mcpServers: [] },
		});
		expect(load.final.error).toBeDefined();
	});
});
