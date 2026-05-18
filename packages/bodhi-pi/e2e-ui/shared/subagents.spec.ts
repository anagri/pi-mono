import { expect, test } from "../fixtures.ts";
import { scenarioSeedXml } from "../helpers/scenario.ts";

test("subagent: /agents lists the profile and /subagent <name> <task> reports the summary", async ({
	startApp,
	chat,
}) => {
	await startApp({ seedXml: scenarioSeedXml("subagents-extractor") });

	await chat.send("/agents");
	const listMsg = chat.systemMessageWithEvent("list");
	await expect(listMsg).toBeVisible({ timeout: 30_000 });
	await expect(listMsg).toContainText("extractor");

	await chat.send("/subagent extractor summarize doc.md");
	const resultMsg = chat.systemMessageWithEvent("run-result");
	await expect(resultMsg).toBeVisible({ timeout: 120_000 });
	await expect(resultMsg).toHaveAttribute("data-subagent-status", "completed");
	await expect(resultMsg).toHaveAttribute("data-subagent-name", "extractor");
	await expect(resultMsg).toContainText(/fox/i);
});
