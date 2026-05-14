import { expect, test } from "../fixtures.ts";
import { PROMPT_DAY_AFTER_MONDAY } from "../helpers/prompts.ts";

test("simple chat: assistant replies with tuesday", async ({
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
		configJson,
	});

	await chat.send(PROMPT_DAY_AFTER_MONDAY);
	await chat.waitForIdle();

	await expect(chat.lastMessage("assistant")).toContainText(/tuesday/i);

	await expect(wire.rows({ direction: "out", method: "session/prompt" })).toHaveCount(1);
	await expect(wire.rows({ direction: "in", method: "session/update" }).first()).toBeVisible();
});
