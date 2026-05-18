import { expect, test } from "../fixtures.ts";
import { scenarioSeedXml } from "../helpers/scenario.ts";

test("subagent fork: parent reads diff, spawns reviewer fork sub-agent via slash + via LLM-invocation, both surface the sentinel", async ({
	startApp,
	chat,
}) => {
	await startApp({ seedXml: scenarioSeedXml("subagents-fork") });

	await chat.send(
		"Use the read tool to load diff.md so the contents are in your conversation history. Reply with one short confirmation when done.",
	);
	await expect(chat.root.locator('[data-test-message-role="assistant"]').last()).toBeVisible({ timeout: 90_000 });

	await chat.send("/subagent reviewer Identify the new symbol name from the inherited transcript.");
	const slashResult = chat.root.locator('[data-subagent-event="run-result"][data-subagent-name="reviewer"]').last();
	await expect(slashResult).toBeVisible({ timeout: 120_000 });
	await expect.soft(slashResult).toHaveAttribute("data-subagent-status", "completed");
	await expect.soft(slashResult).toContainText("BLUE_FORK_42_handler");

	await chat.send(
		"Now use the reviewer sub-agent again, but this time via a natural-language request: ask the reviewer to confirm the new symbol name.",
	);
	const finalAssistant = chat.root.locator('[data-test-message-role="assistant"]').last();
	await expect.soft(finalAssistant).toContainText("BLUE_FORK_42_handler", { timeout: 120_000 });
});
