import { expect, test } from "../fixtures.ts";
import { scenarioSeedXml } from "../helpers/scenario.ts";

test("tool-call: agent reads seeded file and reports contents", async ({
	gotoStart,
	setup,
	chat,
	wire,
	uniqueUserId,
	configJson,
}) => {
	await gotoStart();
	await setup.fillAndSubmit({
		userId: uniqueUserId,
		email: `${uniqueUserId}@e2e-ui.test`,
		seedXml: scenarioSeedXml("fs-tools-notes-txt"),
		configJson,
	});

	await chat.send("Use the read tool to read notes.txt and tell me what the file contains.");
	await chat.waitForIdle();

	await expect(chat.toolCalls({ status: "completed" }).first()).toBeVisible();
	await expect(wire.rows({ direction: "in", method: "session/update" }).first()).toBeVisible();
});
