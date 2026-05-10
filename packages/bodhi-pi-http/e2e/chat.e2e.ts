import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../src/server/auth/token.js";
import { ssePrompt } from "../test/helpers/sse-client.js";
import { rpc } from "../test/helpers/test-server.js";
import { type RealServer, startRealServer } from "./helpers/real-server.js";

describe("real-LLM chat round-trip via HTTP+SSE", () => {
	let rs: RealServer;

	beforeEach(async () => {
		rs = await startRealServer();
	});

	afterEach(async () => {
		await rs.cleanup();
	});

	it("streams a real assistant reply over SSE", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		await rpc(rs.url, tok, { method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
		const created = await rpc<{ sessionId: string }>(rs.url, tok, {
			method: "session/new",
			params: { cwd: rs.dataDir, mcpServers: [] },
		});

		const result = await ssePrompt(rs.url, tok, {
			method: "session/prompt",
			params: {
				sessionId: created.result.sessionId,
				prompt: [{ type: "text", text: "Say the single word: pong. Nothing else." }],
			},
		});

		expect(result.final.error).toBeUndefined();
		expect(result.final.result).toMatchObject({ stopReason: "end_turn" });

		const text = result.notifications
			.flatMap((n) => {
				const update = (
					n.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }
				)?.update;
				if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
					return [update.content.text ?? ""];
				}
				return [];
			})
			.join("")
			.toLowerCase();
		expect(text).toContain("pong");
	});

	it("preserves history across two independent HTTP requests against a real LLM", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		await rpc(rs.url, tok, { method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
		const created = await rpc<{ sessionId: string }>(rs.url, tok, {
			method: "session/new",
			params: { cwd: rs.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		await ssePrompt(rs.url, tok, {
			method: "session/prompt",
			params: {
				sessionId,
				prompt: [{ type: "text", text: "Remember the magic word: zephyr-9921. Reply with only 'ok'." }],
			},
		});

		const r2 = await ssePrompt(rs.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "What was the magic word? Reply with only the word." }] },
		});

		const text = r2.notifications
			.flatMap((n) => {
				const update = (
					n.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }
				)?.update;
				if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
					return [update.content.text ?? ""];
				}
				return [];
			})
			.join("")
			.toLowerCase();
		expect(text).toContain("zephyr-9921");
	});
});
