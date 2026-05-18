import { expect, test } from "../fixtures.ts";
import { scenarioSeedXml } from "../helpers/scenario.ts";

test("subagent_batch: natural-language prompt triggers the LLM to dispatch three counters in parallel; final assistant message carries every result", async ({
	startApp,
	chat,
}) => {
	await startApp({ seedXml: scenarioSeedXml("subagents-batch") });

	await chat.send(
		"Use the subagent_batch tool in a single tool call to dispatch the word-count, line-count, and char-count sub-agents in parallel against sample.txt. Then reply with one line per sub-agent's verbatim output.",
	);

	const finalAssistant = chat.root.locator('[data-message-role="assistant"]').last();
	await expect(finalAssistant).toContainText(/word-count\s*:\s*\d+/i, { timeout: 180_000 });
	await expect(finalAssistant).toContainText(/line-count\s*:\s*\d+/i);
	await expect(finalAssistant).toContainText(/char-count\s*:\s*\d+/i);
});
