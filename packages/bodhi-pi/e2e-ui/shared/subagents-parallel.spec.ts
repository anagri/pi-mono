import { expect, test } from "../fixtures.ts";
import { scenarioSeedXml } from "../helpers/scenario.ts";

test("parallel subagent calls: natural-language prompt triggers the LLM to dispatch three counters via separate subagent tool calls; final assistant message carries every result", async ({
	startApp,
	chat,
}) => {
	await startApp({ seedXml: scenarioSeedXml("subagents-batch") });

	await chat.send(
		"Dispatch the word-count, line-count, and char-count sub-agents against sample.txt in parallel by issuing three separate `subagent` tool calls in the same assistant turn (one tool call per counter). After all three return, summarise each sub-agent's count in your final reply.",
	);

	const finalAssistant = chat.root.locator('[data-message-role="assistant"]').last();
	await expect(finalAssistant).toContainText(/word.{0,25}\d+/i, { timeout: 180_000 });
	await expect(finalAssistant).toContainText(/line.{0,25}\d+/i);
	await expect(finalAssistant).toContainText(/char.{0,25}\d+/i);

	const subagentToolCalls = chat.root.locator('[data-tool-name="subagent"]');
	const count = await subagentToolCalls.count();
	expect(count, `expected >=2 separate subagent tool-call rows; got ${count}`).toBeGreaterThanOrEqual(2);
});
