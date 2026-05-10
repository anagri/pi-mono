import { getModel } from "@mariozechner/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!;

let harness: CliTestHarness;

afterEach(async () => {
	await harness?.cleanup();
});

test("multi-turn context survives across two prompts in the same Node-host session", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	// Turn 1: state a fact, ask for a single-word ack.
	harness.updates.length = 0;
	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "My favourite number is 42. Reply with the single word 'noted' and nothing else.",
			},
		],
	});
	const noteText = chunkedAgentText(harness.updates).toLowerCase();
	expect(noteText, `expected acknowledgement, got: ${JSON.stringify(noteText)}`).toContain("noted");

	// Turn 2: ask for the fact back; proves message history is in the prompt context.
	harness.updates.length = 0;
	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "What is my favourite number? Reply with just the digits and nothing else.",
			},
		],
	});
	const recall = chunkedAgentText(harness.updates);
	expect(recall, `expected recall of '42', got: ${JSON.stringify(recall)}`).toContain("42");
});

// Mirrors bodhi-pi/e2e/chat.e2e.ts "switching model mid-session" — same provenance
// signal, same setSessionConfigOption flow, but driven through the Node host
// (createCliAgent + createSqliteSessionStore + createNodeFilesystem).
test("mid-session model switch via setSessionConfigOption flips OpenAI ↔ Anthropic provenance", async () => {
	const openai = getModel("openai", "gpt-4o-mini");
	const claude = getModel("anthropic", "claude-haiku-4-5");

	harness = await createCliTestHarness({
		model: openai,
		apiKey: OPENAI_KEY,
		extraModels: [claude],
		getApiKey: (p) => {
			if (p === "openai") return OPENAI_KEY;
			if (p === "anthropic") return ANTHROPIC_KEY;
			return undefined;
		},
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	const provenance =
		"Are you made by Anthropic or by OpenAI? Answer with exactly one of those two words and nothing else.";

	harness.updates.length = 0;
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: provenance }] });
	const openaiText = chunkedAgentText(harness.updates).toLowerCase();
	expect(
		openaiText.includes("openai") || openaiText.includes("gpt") || openaiText.includes("chatgpt"),
		`expected openai provenance, got: ${JSON.stringify(openaiText)}`,
	).toBe(true);

	const switchResult = await harness.clientConn.setSessionConfigOption({
		sessionId,
		configId: "model",
		value: claude.id,
	});
	expect((switchResult.configOptions[0] as { currentValue?: string })?.currentValue).toBe(claude.id);

	harness.updates.length = 0;
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: provenance }] });
	const claudeText = chunkedAgentText(harness.updates).toLowerCase();
	expect(
		claudeText.includes("anthropic") || claudeText.includes("claude"),
		`expected anthropic provenance after switch, got: ${JSON.stringify(claudeText)}`,
	).toBe(true);
});
