import type { SessionNotification } from "@agentclientprotocol/sdk";
import { LLMock } from "@copilotkit/aimock";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createBodhiPiAgent } from "../src/index.js";
import { createInProcessAcpPair } from "./helpers/in-process-connection.js";

let mock: LLMock;

beforeEach(async () => {
	mock = new LLMock({ port: 0 });
	await mock.start();
});

afterEach(async () => {
	await mock.stop();
});

test("simple chat round-trips via ACP through aimock", async () => {
	mock.onMessage(/Monday/i, { content: "tuesday" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const updates: SessionNotification[] = [];

	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			model: { ...baseModel, baseUrl: `${mock.url}/v1` },
			getApiKey: () => "test-key",
		}),
		() => ({
			sessionUpdate: async (params) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		}),
	);

	await clientConn.initialize({
		protocolVersion: 1,
		clientCapabilities: {
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
		},
	});

	const { sessionId } = await clientConn.newSession({
		cwd: process.cwd(),
		mcpServers: [],
	});

	const result = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Answer in one word: what day comes after Monday?" }],
	});

	expect(result.stopReason).toBe("end_turn");

	const chunks = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
	expect(chunks.length).toBeGreaterThanOrEqual(1);

	const text = chunks
		.map((u) => {
			const content = (u.update as { content: { type: string; text?: string } }).content;
			return content.type === "text" ? (content.text ?? "") : "";
		})
		.join("");
	expect(text.trim().toLowerCase()).toBe("tuesday");
});
