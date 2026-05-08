import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { asSelectOption } from "@test/helpers/acp-narrow.js";
import { requireEnv } from "@test/helpers/env.js";
import { createTestHarness } from "@test/helpers/harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";

async function runSingleTurn(opts: { model: Model<Api>; apiKey: string; provider: string; prompt: string }) {
	const { clientConn, updates } = createTestHarness({
		models: [opts.model],
		defaultModelId: opts.model.id,
		getApiKey: (p) => (p === opts.provider ? opts.apiKey : undefined),
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	const result = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: opts.prompt }],
	});
	const chunks = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
	return {
		stopReason: result.stopReason,
		chunks,
		text: chunkedAgentText(updates),
	};
}

test("Anthropic Haiku replies with tuesday via ACP", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");

	const result = await runSingleTurn({
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
	const apiKey = requireEnv("OPENAI_API_KEY");

	const result = await runSingleTurn({
		model: getModel("openai", "gpt-5-mini"),
		apiKey,
		provider: "openai",
		prompt: "Answer in one word: what day comes after Monday?",
	});

	expect(result.stopReason).toBe("end_turn");
	expect(result.chunks.length).toBeGreaterThanOrEqual(1);
	expect(result.text.toLowerCase()).toContain("tuesday");
});

test("switching model mid-session changes provenance", async () => {
	const anthropicKey = requireEnv("ANTHROPIC_API_KEY");
	const openaiKey = requireEnv("OPENAI_API_KEY");

	const claude = getModel("anthropic", "claude-haiku-4-5");
	const gpt = getModel("openai", "gpt-5-mini");

	const { clientConn, updates } = createTestHarness({
		models: [claude, gpt],
		defaultModelId: claude.id,
		getApiKey: (p) => {
			if (p === "anthropic") return anthropicKey;
			if (p === "openai") return openaiKey;
			return undefined;
		},
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId, configOptions } = await clientConn.newSession({
		cwd: process.cwd(),
		mcpServers: [],
	});
	const initialOption = asSelectOption(configOptions?.[0]);
	expect(initialOption.currentValue).toBe(claude.id);
	expect(initialOption.options).toHaveLength(2);

	const provenancePrompt =
		"Are you made by Anthropic or by OpenAI? Answer with exactly one of those two words and nothing else.";

	updates.length = 0;
	const claudeResult = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: provenancePrompt }],
	});
	expect(claudeResult.stopReason).toBe("end_turn");
	const claudeText = chunkedAgentText(updates).toLowerCase();
	// Substring match — real LLMs vary phrasing run-to-run.
	expect(
		claudeText.includes("anthropic") || claudeText.includes("claude"),
		`expected anthropic provenance, got: ${JSON.stringify(claudeText)}`,
	).toBe(true);

	const switchResult = await clientConn.setSessionConfigOption({
		sessionId,
		configId: "model",
		value: gpt.id,
	});
	const switched = asSelectOption(switchResult.configOptions[0]);
	expect(switched.currentValue).toBe(gpt.id);

	updates.length = 0;
	const gptResult = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: provenancePrompt }],
	});
	expect(gptResult.stopReason).toBe("end_turn");
	const gptText = chunkedAgentText(updates).toLowerCase();
	expect(
		gptText.includes("openai") || gptText.includes("gpt") || gptText.includes("chatgpt"),
		`expected openai provenance, got: ${JSON.stringify(gptText)}`,
	).toBe(true);
});

test("real LLM remembers context across two prompts in same session", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");

	const haiku = getModel("anthropic", "claude-haiku-4-5");
	const { clientConn, updates } = createTestHarness({
		models: [haiku],
		defaultModelId: haiku.id,
		getApiKey: (p) => (p === "anthropic" ? apiKey : undefined),
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	// Turn 1: state a fact.
	updates.length = 0;
	await clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "My favourite number is 42. Reply with the single word 'noted' and nothing else.",
			},
		],
	});
	const noteText = chunkedAgentText(updates).toLowerCase();
	expect(noteText.includes("noted"), `expected acknowledgment, got: ${JSON.stringify(noteText)}`).toBe(true);

	// Turn 2: ask for the fact back — proves multi-turn context survives.
	updates.length = 0;
	await clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "What is my favourite number? Reply with just the digits and nothing else.",
			},
		],
	});
	const recallText = chunkedAgentText(updates);
	expect(recallText.includes("42"), `expected to recall '42', got: ${JSON.stringify(recallText)}`).toBe(true);
});
