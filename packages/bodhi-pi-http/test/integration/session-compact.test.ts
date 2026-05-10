import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — _bodhi-pi/session/compact (per-turn agent rebuild)", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("compacts after two prompts; summary persisted; subsequent prompt sees the synthesized summary", async () => {
		ts.faux.setResponses([
			fauxAssistantMessage("first reply about pet name Mango"),
			fauxAssistantMessage("second reply about Tuesday"),
			fauxAssistantMessage("## Goal\nrigged-summary about Mango and weekdays"),
			fauxAssistantMessage("third reply mentioning Mango"),
		]);

		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		const r1 = await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "Remember: pet's name is Mango" }] },
		});
		expect(r1.final.error).toBeUndefined();

		const r2 = await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "What comes after Monday?" }] },
		});
		expect(r2.final.error).toBeUndefined();

		const compact = await rpc<{ summary: string; firstKeptEntryId: string; tokensBefore: number }>(ts.url, tok, {
			method: "_bodhi-pi/session/compact",
			params: { sessionId },
		});
		expect(compact.result.summary).toContain("rigged-summary");
		expect(typeof compact.result.firstKeptEntryId).toBe("string");

		const r3 = await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "What is the pet's name?" }] },
		});
		expect(r3.final.error).toBeUndefined();
	});
});
