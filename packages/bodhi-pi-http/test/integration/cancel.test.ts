import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("session/cancel mid-stream", () => {
	let ts: TestServer;

	beforeEach(async () => {
		// Slow streaming so we have time to cancel mid-flight.
		ts = await startTestServer({ tokensPerSecond: 5 });
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("ends SSE with stopReason='cancelled' when cancel arrives mid-stream", async () => {
		// A long enough response that streaming takes noticeably longer than
		// the cancel POST round-trip below.
		ts.faux.setResponses([
			fauxAssistantMessage(
				"this is a fairly long response that will stream over a number of small chunks so we can interrupt it cleanly mid way",
			),
		]);

		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		// Kick off the prompt (don't await it yet).
		const promptPromise = ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "go" }] },
		});

		// Wait briefly so the prompt is mid-stream, then cancel.
		await sleep(80);
		await rpc(ts.url, tok, { method: "session/cancel", params: { sessionId } });

		const result = await promptPromise;
		expect(result.final.error).toBeUndefined();
		const final = result.final.result as { stopReason?: string };
		expect(final.stopReason).toBe("cancelled");
	});
});

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
