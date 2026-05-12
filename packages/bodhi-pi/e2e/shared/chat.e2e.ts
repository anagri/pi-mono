import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { asSelectOption } from "@test/helpers/acp-narrow.js";
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
	const result = await runSingleTurn({
		model: getModel("anthropic", "claude-haiku-4-5"),
		apiKey: process.env.ANTHROPIC_API_KEY!,
		provider: "anthropic",
		prompt: "Answer in one word: what day comes after Monday?",
	});

	expect(result.stopReason).toBe("end_turn");
	expect(result.chunks.length).toBeGreaterThanOrEqual(1);
	expect(result.text.toLowerCase()).toContain("tuesday");
});

test("OpenAI gpt-5-mini replies with tuesday via ACP", async () => {
	const result = await runSingleTurn({
		model: getModel("openai", "gpt-5-mini"),
		apiKey: process.env.OPENAI_API_KEY!,
		provider: "openai",
		prompt: "Answer in one word: what day comes after Monday?",
	});

	expect(result.stopReason).toBe("end_turn");
	expect(result.chunks.length).toBeGreaterThanOrEqual(1);
	expect(result.text.toLowerCase()).toContain("tuesday");
});

test("switching model mid-session changes provenance", async () => {
	const claude = getModel("anthropic", "claude-haiku-4-5");
	const gpt = getModel("openai", "gpt-5-mini");

	const h = await createE2EHarness({
		models: [claude, gpt],
		defaultModelId: claude.id,
		getApiKey: (p) => {
			if (p === "anthropic") return process.env.ANTHROPIC_API_KEY!;
			if (p === "openai") return process.env.OPENAI_API_KEY!;
			return undefined;
		},
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId, configOptions } = await h.clientConn.newSession({
		cwd: h.cwd,
		mcpServers: [],
	});
	// At least claude + gpt must be in the model select. The harness may have
	// other models registered too (shared http server boots with a wider list);
	// we don't assert the option count.
	const initialOption = asSelectOption(configOptions?.[0]);
	const ids = (initialOption.options as Array<{ value: string }>).map((o) => o.value);
	expect(ids).toContain(claude.id);
	expect(ids).toContain(gpt.id);

	// Pin to claude before the first prompt so the assertion is independent of
	// the harness's boot-time default.
	await h.clientConn.setSessionConfigOption({ sessionId, configId: "model", value: claude.id });

	const provenancePrompt =
		"Are you made by Anthropic or by OpenAI? Answer with exactly one of those two words and nothing else.";

	h.updates.length = 0;
	const claudeResult = await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: provenancePrompt }],
	});
	expect(claudeResult.stopReason).toBe("end_turn");
	const claudeText = chunkedAgentText(h.updates).toLowerCase();
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
	const haiku = getModel("anthropic", "claude-haiku-4-5");
	const h = await createE2EHarness({
		models: [haiku],
		defaultModelId: haiku.id,
		getApiKey: (p) => (p === "anthropic" ? process.env.ANTHROPIC_API_KEY! : undefined),
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

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
