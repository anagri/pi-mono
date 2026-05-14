import { expect, test } from "../fixtures.ts";
import { scenarioSeedXml } from "../helpers/scenario.ts";

test("tool-call: agent reads seeded file and reports contents", async ({ startApp, chat, wire }) => {
	await startApp({ seedXml: scenarioSeedXml("fs-tools-notes-txt") });

	await chat.send("Use the read tool to read notes.txt and tell me what the file contains.");
	await chat.waitForIdle();

	await expect(chat.toolCalls({ status: "completed" }).first()).toBeVisible();
	await expect(wire.rows({ direction: "in", method: "session/update" }).first()).toBeVisible();
});
