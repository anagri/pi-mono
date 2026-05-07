import type { SessionNotification } from "@agentclientprotocol/sdk";
import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { expect, test } from "vitest";
import { createBodhiPiAgent } from "../src/index.js";
import { createInProcessAcpPair } from "../test/helpers/in-process-connection.js";

async function runChatTurn(opts: {
	model: Model<Api>;
	apiKey: string;
	provider: string;
	prompt: string;
}): Promise<{ stopReason: string; chunks: SessionNotification[]; text: string }> {
	const updates: SessionNotification[] = [];

	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			model: opts.model,
			getApiKey: (p) => (p === opts.provider ? opts.apiKey : undefined),
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
		prompt: [{ type: "text", text: opts.prompt }],
	});

	const chunks = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
	const text = chunks
		.map((u) => {
			const content = (u.update as { content: { type: string; text?: string } }).content;
			return content.type === "text" ? (content.text ?? "") : "";
		})
		.join("");

	return { stopReason: result.stopReason, chunks, text };
}

test("Anthropic Haiku replies with tuesday via ACP", async () => {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set in e2e/.env.test to run e2e tests");

	const result = await runChatTurn({
		model: getModel("anthropic", "claude-haiku-4-5"),
		apiKey,
		provider: "anthropic",
		prompt: "Answer in one word: what day comes after Monday?",
	});

	expect(result.stopReason).toBe("end_turn");
	expect(result.chunks.length).toBeGreaterThanOrEqual(1);
	expect(result.text.toLowerCase()).toContain("tuesday");
});

test("OpenAI gpt-5-mini replies with tuesday via ACP", async () => {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY must be set in e2e/.env.test to run e2e tests");

	const result = await runChatTurn({
		model: getModel("openai", "gpt-5-mini"),
		apiKey,
		provider: "openai",
		prompt: "Answer in one word: what day comes after Monday?",
	});

	expect(result.stopReason).toBe("end_turn");
	expect(result.chunks.length).toBeGreaterThanOrEqual(1);
	expect(result.text.toLowerCase()).toContain("tuesday");
});
