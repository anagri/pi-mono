import { expect, test } from "../fixtures.ts";
import { scenarioSeedXml } from "../helpers/scenario.ts";

test("workspace-fs: agent lists workspace files", async ({ gotoStart, setup, chat, uniqueUserId, configJson }) => {
	await gotoStart();
	await setup.fillAndSubmit({
		userId: uniqueUserId,
		email: `${uniqueUserId}@e2e-ui.test`,
		seedXml: scenarioSeedXml("default"),
		configJson,
	});

	await chat.send("Use the ls tool to list files in the current workspace.");
	await chat.waitForIdle();

	await expect(chat.toolCalls({ status: "completed" }).first()).toBeVisible();
	await expect(chat.lastMessage("assistant")).toContainText(/readme/i);
});
