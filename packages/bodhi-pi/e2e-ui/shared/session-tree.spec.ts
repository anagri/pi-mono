import { expect, test } from "../fixtures.ts";
import { PROMPT_DAY_AFTER_MONDAY } from "../helpers/prompts.ts";

test("session-tree: /sessions, /clone, /new, /resume, /close", async ({
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

	// Step 1: seed a real turn so the session DAG has an entry.
	await chat.send(PROMPT_DAY_AFTER_MONDAY);
	await chat.waitForIdle();
	await expect(chat.lastMessage("assistant")).toContainText(/tuesday/i);

	const sessionA = await chat.sessionId();
	expect(sessionA).not.toBe("");

	// Step 2: /sessions lists the current session.
	await chat.send("/sessions");
	await expect(chat.lastMessage("system")).toContainText(/sessions:/);
	await expect(chat.lastMessage("system")).toContainText(sessionA);

	// Step 3: /clone returns a fresh session id distinct from A.
	await chat.send("/clone");
	await expect(chat.lastMessage("system")).toContainText(/cloned:/);
	const clonedText = await chat.lastMessage("system").innerText();
	const clonedMatch = clonedText.match(/cloned:\s*([0-9a-f-]{8,})/i);
	expect(clonedMatch, `expected a uuid in: ${clonedText}`).not.toBeNull();
	const sessionClone = clonedMatch![1]!;
	expect(sessionClone).not.toBe(sessionA);

	// Step 4: /new flips data-session-id to a fresh id, distinct from A.
	await chat.send("/new");
	await expect.poll(async () => (await chat.sessionId()) !== sessionA, { timeout: 10_000 }).toBe(true);
	const sessionB = await chat.sessionId();
	expect(sessionB).not.toBe(sessionA);
	expect(sessionB).not.toBe("");

	// Confirm the new session can still chat — proves the swap is wired.
	await chat.send(PROMPT_DAY_AFTER_MONDAY);
	await chat.waitForIdle();
	await expect(chat.lastMessage("assistant").last()).toContainText(/tuesday/i);

	// Step 5: /resume A flips data-session-id back to A.
	await chat.send(`/resume ${sessionA}`);
	await expect.poll(() => chat.sessionId(), { timeout: 10_000 }).toBe(sessionA);
	await expect(chat.lastMessage("system")).toContainText(/resumed session:/);

	// Step 6: /close prints a confirmation system message.
	await chat.send("/close");
	await expect(chat.lastMessage("system")).toContainText(/closed session:/);
});
