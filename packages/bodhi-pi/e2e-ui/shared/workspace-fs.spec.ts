import { expect, test } from "../fixtures.ts";
import { scenarioSeedXml } from "../helpers/scenario.ts";

test("workspace-fs: agent lists workspace files", async ({ startApp, chat }) => {
	await startApp({ seedXml: scenarioSeedXml("default") });

	await chat.send("Use the ls tool to list files in the current workspace.");
	await chat.waitForIdle();

	await expect(chat.toolCalls({ status: "completed" }).first()).toBeVisible();
	await expect(chat.lastMessage("assistant")).toContainText(/readme/i);
});
