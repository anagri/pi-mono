import { expect, test } from "../fixtures.ts";
import { scenarioSeedXml } from "../helpers/scenario.ts";

test("subagent built-ins: /agents lists explore + planner without any project seed", async ({ startApp, chat }) => {
	await startApp();

	await chat.send("/agents");
	const listMsg = chat.root.locator('[data-subagent-event="list"]');
	await expect(listMsg).toBeVisible({ timeout: 30_000 });
	await expect(listMsg).toContainText("explore");
	await expect(listMsg).toContainText("planner");
});

test("subagent built-ins: /subagent explore <task> spawns the bundled explore profile and reports the sentinel", async ({
	startApp,
	chat,
}) => {
	await startApp({ seedXml: scenarioSeedXml("subagents-builtin") });

	await chat.send("/subagent explore Read sentinel.md and report the secret sentinel keyword verbatim.");
	const resultMsg = chat.root.locator('[data-subagent-event="run-result"]');
	await expect(resultMsg).toBeVisible({ timeout: 120_000 });
	await expect(resultMsg).toHaveAttribute("data-subagent-status", "completed");
	await expect(resultMsg).toHaveAttribute("data-subagent-name", "explore");
	await expect(resultMsg).toContainText("BLUE_SWALLOW_42");
});

test("subagent built-ins: natural-language prompt triggers the LLM to invoke the subagent tool, sentinel reaches the final assistant message", async ({
	startApp,
	chat,
}) => {
	await startApp({ seedXml: scenarioSeedXml("subagents-builtin") });

	await chat.send(
		"Use the explore sub-agent to read sentinel.md and report the secret sentinel keyword. Reply with the keyword verbatim.",
	);

	const finalAssistant = chat.root.locator('[data-test-message-role="assistant"]').last();
	await expect(finalAssistant).toContainText("BLUE_SWALLOW_42", { timeout: 120_000 });
});
