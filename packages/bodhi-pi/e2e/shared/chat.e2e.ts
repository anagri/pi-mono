import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { asSelectOption } from "@test/helpers/acp-narrow.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

async function runSingleTurn(opts: { model: Model<Api>; provider: "openai" | "anthropic"; prompt: string }) {
	const h = harness.set(
		await createE2EHarness({
			models: [opts.model],
			defaultModelId: opts.model.id,
			getApiKey: envKeysFor(opts.provider),
		}),
	);

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
		model: getModel("anthropic", "claude-haiku-4-5-20251001"),
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
		provider: "openai",
		prompt: "Answer in one word: what day comes after Monday?",
	});

	expect(result.stopReason).toBe("end_turn");
	expect(result.chunks.length).toBeGreaterThanOrEqual(1);
	expect(result.text.toLowerCase()).toContain("tuesday");
});

test("switching model mid-session changes provenance", async () => {
	const claude = getModel("anthropic", "claude-haiku-4-5-20251001");
	const gpt = getModel("openai", "gpt-5-mini");

	const h = harness.set(
		await createE2EHarness({
			models: [claude, gpt],
			defaultModelId: claude.id,
			getApiKey: envKeysFor("anthropic", "openai"),
		}),
	);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId, configOptions } = await h.clientConn.newSession({
		cwd: h.cwd,
		mcpServers: [],
	});
	// At least claude + gpt must be in the model select. The harness may have
	// other models registered too (shared http server boots with a wider list);
	// we don't assert the option count.
	const initialOption = asSelectOption(configOptions?.find((o) => o.id === "model"));
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
	const switched = asSelectOption(switchResult.configOptions.find((o) => o.id === "model"));
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
	const haiku = getModel("anthropic", "claude-haiku-4-5-20251001");
	const h = harness.set(
		await createE2EHarness({
			models: [haiku],
			defaultModelId: haiku.id,
			getApiKey: envKeysFor("anthropic"),
		}),
	);

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

test("thinking level: setSessionConfigOption('thinking') persists as a ThinkingChangeEntry", async () => {
	// No real LLM call — exercise only the config-option machinery + entry persistence.
	const claude = getModel("anthropic", "claude-haiku-4-5-20251001");
	const h = harness.set(
		await createE2EHarness({
			models: [claude],
			defaultModelId: claude.id,
			getApiKey: () => "ignored-no-prompt",
		}),
	);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	// The http test-app server boots with its own model list; pin the session
	// to claude-haiku explicitly so the "thinking" selector is in scope under
	// every runtime. Under in-memory/cli this is a no-op (claude is already
	// the default).
	const modelSwitch = await h.clientConn.setSessionConfigOption({
		sessionId,
		configId: "model",
		value: claude.id,
	});
	const thinkingOption = (modelSwitch.configOptions ?? []).find((o) => o.id === "thinking");
	if (!thinkingOption) throw new Error("expected 'thinking' configOption after pinning claude-haiku-4-5-20251001");
	const select = asSelectOption(thinkingOption);
	const values = (select.options as Array<{ value: string }>).map((o) => o.value);
	const otherLevel = values.find((v) => v !== select.currentValue);
	if (!otherLevel) throw new Error(`expected an alternative thinking level; got: ${JSON.stringify(values)}`);

	const switchResult = await h.clientConn.setSessionConfigOption({
		sessionId,
		configId: "thinking",
		value: otherLevel,
	});
	const updated = (switchResult.configOptions ?? []).find((o) => o.id === "thinking");
	if (!updated) throw new Error("expected updated 'thinking' option in response");
	expect.soft(asSelectOption(updated).currentValue).toBe(otherLevel);

	// The agent appends a `thinking_change` entry to the session record.
	const tree = await h.client.getSessionTree({ sessionId });
	const change = tree.nodes.find((n) => n.type === "thinking_change");
	expect.soft(change, "expected thinking_change entry in session tree").toBeDefined();
});
