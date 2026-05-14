import { expect, test } from "../fixtures.ts";
import { PROMPT_DAY_AFTER_MONDAY } from "../helpers/prompts.ts";

test("session-tree: /sessions, /clone, /new, /resume, /close", async ({ startApp, chat }) => {
	await startApp();

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

	// Step 3: /clone — read the cloned id off the system message's data-session-id
	// attribute rather than regex-parsing its text.
	await chat.send("/clone");
	const clonedMsg = chat.lastMessage("system");
	await expect(clonedMsg).toHaveAttribute("data-session-event", "cloned");
	const sessionClone = (await clonedMsg.getAttribute("data-session-id")) ?? "";
	expect(sessionClone).not.toBe("");
	expect(sessionClone).not.toBe(sessionA);

	// Step 4: /new flips data-session-id to a fresh id, distinct from A.
	await chat.send("/new");
	await expect.poll(async () => (await chat.sessionId()) !== sessionA).toBe(true);
	const sessionB = await chat.sessionId();
	expect(sessionB).not.toBe(sessionA);
	expect(sessionB).not.toBe("");

	// Confirm the new session can still chat — proves the swap is wired.
	await chat.send(PROMPT_DAY_AFTER_MONDAY);
	await chat.waitForIdle();
	await expect(chat.lastMessage("assistant").last()).toContainText(/tuesday/i);

	// Step 5: /resume A flips data-session-id back to A.
	await chat.send(`/resume ${sessionA}`);
	await expect.poll(() => chat.sessionId()).toBe(sessionA);
	await expect(chat.lastMessage("system")).toHaveAttribute("data-session-event", "resumed");
	await expect(chat.lastMessage("system")).toHaveAttribute("data-session-id", sessionA);

	// Step 6: /close prints a confirmation system message.
	await chat.send("/close");
	await expect(chat.lastMessage("system")).toHaveAttribute("data-session-event", "closed");
});
