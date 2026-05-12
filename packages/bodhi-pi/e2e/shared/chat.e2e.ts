import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { asSelectOption } from "@test/helpers/acp-narrow.js";
import { requireEnv } from "@test/helpers/env.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

async function runSingleTurn(opts: { model: Model<Api>; apiKey: string; provider: string; prompt: string }) {
	const h = await createE2EHarness({
		models: [opts.model],
		defaultModelId: opts.model.id,
		getApiKey: (p) => (p === opts.provider ? opts.apiKey : undefined),
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	const result = await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: opts.prompt }],
	});
	const chunks = h.updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
	return {
		stopReason: result.stopReason,
		chunks,
		text: chunkedAgentText(h.updates),
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

	const h = await createE2EHarness({
		models: [claude, gpt],
		defaultModelId: claude.id,
		getApiKey: (p) => {
			if (p === "anthropic") return anthropicKey;
			if (p === "openai") return openaiKey;
			return undefined;
		},
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId, configOptions } = await h.clientConn.newSession({
		cwd: h.cwd,
		mcpServers: [],
	});
	const initialOption = asSelectOption(configOptions?.[0]);
	expect(initialOption.currentValue).toBe(claude.id);
	expect(initialOption.options).toHaveLength(2);

	const provenancePrompt =
		"Are you made by Anthropic or by OpenAI? Answer with exactly one of those two words and nothing else.";

	h.updates.length = 0;
	const claudeResult = await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: provenancePrompt }],
	});
	expect(claudeResult.stopReason).toBe("end_turn");
	const claudeText = chunkedAgentText(h.updates).toLowerCase();
	// Substring match — real LLMs vary phrasing run-to-run.
	expect(
		claudeText.includes("anthropic") || claudeText.includes("claude"),
		`expected anthropic provenance, got: ${JSON.stringify(claudeText)}`,
	).toBe(true);

	const switchResult = await h.clientConn.setSessionConfigOption({
		sessionId,
		configId: "model",
		value: gpt.id,
	});
	const switched = asSelectOption(switchResult.configOptions[0]);
	expect(switched.currentValue).toBe(gpt.id);

	h.updates.length = 0;
	const gptResult = await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: provenancePrompt }],
	});
	expect(gptResult.stopReason).toBe("end_turn");
	const gptText = chunkedAgentText(h.updates).toLowerCase();
	expect(
		gptText.includes("openai") || gptText.includes("gpt") || gptText.includes("chatgpt"),
		`expected openai provenance, got: ${JSON.stringify(gptText)}`,
	).toBe(true);
});

test("real LLM remembers context across two prompts in same session", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");

	const haiku = getModel("anthropic", "claude-haiku-4-5");
	const h = await createE2EHarness({
		models: [haiku],
		defaultModelId: haiku.id,
		getApiKey: (p) => (p === "anthropic" ? apiKey : undefined),
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	// Turn 1: state a fact.
	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "My favourite number is 42. Reply with the single word 'noted' and nothing else.",
			},
		],
	});
	const noteText = chunkedAgentText(h.updates).toLowerCase();
	expect(noteText.includes("noted"), `expected acknowledgment, got: ${JSON.stringify(noteText)}`).toBe(true);

	// Turn 2: ask for the fact back — proves multi-turn context survives.
	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "What is my favourite number? Reply with just the digits and nothing else.",
			},
		],
	});
	const recallText = chunkedAgentText(h.updates);
	expect(recallText.includes("42"), `expected to recall '42', got: ${JSON.stringify(recallText)}`).toBe(true);
});
