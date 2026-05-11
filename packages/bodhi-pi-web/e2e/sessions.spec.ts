import { expect, test } from "./fixtures";

test("M5 session lifecycle via slash commands", async ({ chat }) => {
	let sessionA = "";

	await test.step("session A: prompt with a fact", async () => {
		await chat.goto();
		await chat.waitForState("idle");
		await chat.login("openai", process.env.OPENAI_API_KEY!);
		await chat.send("Remember the codeword 'aurora'. Reply only with: noted");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("noted");
	});

	await test.step("/sessions includes A as current", async () => {
		await chat.send("/sessions");
		const sysLocator = chat.messages("system").last();
		await expect(sysLocator).toContainText(/sessions:/);
		await expect(sysLocator).toContainText("*");
		const sys = (await sysLocator.textContent()) ?? "";
		// /sessions emits full UUIDs next to the * marker so /resume can pick them up.
		const match = sys.match(/\* ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
		expect(match).not.toBeNull();
		sessionA = match![1];
	});

	await test.step("/new starts session B with empty history", async () => {
		await chat.send("/new");
		await expect(chat.messages("system").last()).toContainText("new session");
		// Assistant + user history (other than the slash command echo) cleared.
		expect(await chat.messages("assistant").count()).toBe(0);
	});

	await test.step("/resume A replays history", async () => {
		await chat.send(`/resume ${sessionA}`);
		// Wait for the resumed banner system message to land.
		await expect(chat.messages("system").last()).toContainText("resumed session");
		// History replay: at least one user msg containing 'aurora' and one assistant 'noted'.
		await expect(chat.messages("user")).toContainText(/aurora/i);
		await expect(chat.messages("assistant").last()).toContainText(/noted/i);
	});

	await test.step("after resume, context is alive", async () => {
		await chat.send("What was the codeword? Reply with just the word.");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("aurora");
	});

	await test.step("/close flips state to closed", async () => {
		await chat.send("/close");
		await chat.waitForState("closed");
		await expect(chat.messages("system").last()).toContainText("closed session");
	});

	await test.step("non-slash prompt while closed is rejected", async () => {
		await chat.send("hello");
		await expect(chat.messages("system").last()).toContainText(/closed/i);
	});

	await test.step("/new after close re-enables chat", async () => {
		await chat.send("/new");
		await chat.waitForState("idle");
	});

	await test.step("/delete A removes A from /sessions", async () => {
		await chat.send(`/delete ${sessionA}`);
		await expect(chat.messages("system").last()).toContainText("deleted session");
		await chat.send("/sessions");
		await expect(chat.messages("system").last()).not.toContainText(sessionA);
	});
});

test("M6 reload resumes the last session via Dexie + sessionStorage", async ({ chat }) => {
	await test.step("seed a session with a known fact", async () => {
		await chat.goto();
		await chat.waitForState("idle");
		await chat.login("openai", process.env.OPENAI_API_KEY!);
		await chat.send("Remember the codeword 'cobalt'. Reply only with: noted");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("noted");
	});

	await test.step("reload the page", async () => {
		await chat.page.reload();
		await chat.waitForState("idle");
	});

	await test.step("history replays via session/load", async () => {
		// loadSession streams user_message_chunk + agent_message_chunk for each
		// persisted message. render.ts dispatches them into the chat store.
		await expect(chat.messages("user")).toContainText(/cobalt/i);
		await expect(chat.messages("assistant").last()).toContainText(/noted/i);
	});

	await test.step("post-reload context is alive", async () => {
		await chat.send("What was the codeword? Reply with just the word.");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("cobalt");
	});
});
