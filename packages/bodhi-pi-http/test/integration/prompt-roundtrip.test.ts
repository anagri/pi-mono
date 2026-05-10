import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — session/prompt (single turn, faux LLM)", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("streams a faux assistant reply over SSE", async () => {
		ts.faux.setResponses([fauxAssistantMessage("pong from faux")]);
		const tok = encodeToken({ id: 1, email: "alice@example.com" });

		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});

		const result = await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: {
				sessionId: created.result.sessionId,
				prompt: [{ type: "text", text: "ping" }],
			},
		});

		expect(result.final.error).toBeUndefined();
		expect(result.final.result).toMatchObject({ stopReason: "end_turn" });

		const text = result.notifications
			.filter((n) => n.method === "session/update")
			.flatMap((n) => {
				const update = (
					n.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }
				)?.update;
				if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
					return [update.content.text ?? ""];
				}
				return [];
			})
			.join("");
		expect(text).toContain("pong from faux");
	});
});
