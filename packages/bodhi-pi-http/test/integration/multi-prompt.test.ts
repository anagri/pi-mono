import { type Context, fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("multi-prompt across separate HTTP requests — KEY PROOF of serialize/deserialize", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("second turn's LLM input includes the first turn's history", async () => {
		// Capture the messages sent to the LLM on each call.
		const captured: Context[] = [];
		ts.faux.setResponses([
			fauxAssistantMessage("I am A — first reply"),
			(context: Context) => {
				captured.push({ ...context, messages: [...context.messages] });
				return fauxAssistantMessage("second reply");
			},
		]);

		const tok = encodeToken({ id: 1, email: "alice@example.com" });

		// Each of these is a separate HTTP request. Between them, the agent is
		// torn down and rebuilt fresh from store on the next request.
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		const r1 = await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "tell me your name" }] },
		});
		expect(r1.final.error).toBeUndefined();

		const r2 = await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "and what did you say?" }] },
		});
		expect(r2.final.error).toBeUndefined();

		// The faux provider's second-call factory captured the full message array
		// it received. That array MUST include the first turn's user prompt and
		// the first assistant reply — proving the agent re-hydrated session state
		// from SQLite between independent HTTP requests.
		expect(captured.length).toBe(1);
		const messages = captured[0].messages;
		const userTexts = messages.filter((m) => m.role === "user").flatMap((m) => extractTexts(m.content));
		const assistantTexts = messages
			.filter((m) => m.role === "assistant")
			.flatMap((m) => {
				if (typeof m.content === "string") return [m.content];
				return m.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text);
			});

		expect(userTexts.join(" ")).toContain("tell me your name");
		expect(userTexts.join(" ")).toContain("and what did you say?");
		expect(assistantTexts.join(" ")).toContain("I am A — first reply");
	});
});

function extractTexts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "type" in b)
			.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
			.filter((s) => s.length > 0);
	}
	return [];
}
