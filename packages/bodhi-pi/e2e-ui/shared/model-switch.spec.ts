import { expect, test } from "../fixtures.ts";
import { PROMPT_DAY_AFTER_MONDAY, SWITCH_TARGET_MODEL } from "../helpers/prompts.ts";

test("model-switch: /model anthropic mid-thread updates data-current-model", async ({
	gotoStart,
	setup,
	chat,
	uniqueUserId,
	configJson,
}) => {
	await gotoStart();
	await setup.fillAndSubmit({
		userId: uniqueUserId,
		email: `${uniqueUserId}@e2e-ui.test`,
		configJson,
	});

	// Trigger lazy-init so a session exists; /model needs a bound sessionId.
	await chat.send(PROMPT_DAY_AFTER_MONDAY);
	await chat.waitForIdle();
	await expect(chat.lastMessage("assistant")).toContainText(/tuesday/i);

	const before = await chat.currentModel();
	expect(before).not.toBe("");
	expect(before).not.toBe(SWITCH_TARGET_MODEL);

	await chat.send(`/model ${SWITCH_TARGET_MODEL}`);
	await expect.poll(() => chat.currentModel(), { timeout: 10_000 }).toBe(SWITCH_TARGET_MODEL);
	await expect(chat.lastMessage("system")).toContainText("model switched to:");

	// Confirm the new model handles a real prompt — proves the switch is wired,
	// not just an attribute flip.
	await chat.send("Answer in one word: what day comes after Friday?");
	await chat.waitForIdle();
	await expect(chat.lastMessage("assistant")).toContainText(/saturday/i);
});
