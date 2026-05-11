import { expect, test } from "./fixtures";

test("/fork before a user message creates a new session whose /entries excludes that turn", async ({ chat }) => {
	await chat.goto();
	await chat.waitForState("idle");
	await chat.login("openai", process.env.OPENAI_API_KEY!);

	let forkAtId = "";

	await test.step("seed two turns", async () => {
		await chat.send("Reply with one word: morning. Just 'morning'.");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		await chat.send("Reply with one word: evening. Just 'evening'.");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
	});

	await test.step("/entries surfaces both user message ids", async () => {
		await chat.send("/entries");
		const sysLocator = chat.messages("system").last();
		await expect(sysLocator).toContainText(/entries:/);
		const text = (await sysLocator.textContent()) ?? "";
		const matches = [...text.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+user/g)];
		expect(matches.length).toBe(2);
		forkAtId = matches[1][1];
	});

	await test.step("/fork <id> succeeds and surfaces a new session id distinct from the original", async () => {
		await chat.send(`/fork ${forkAtId}`);
		const sysLocator = chat.messages("system").last();
		await expect(sysLocator).toContainText(/forked:/);
		const text = (await sysLocator.textContent()) ?? "";
		const newIdMatch = text.match(/forked: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
		expect(newIdMatch).not.toBeNull();
		await expect(sysLocator).toContainText(/evening/);
	});
});

test("/clone produces a new session id", async ({ chat }) => {
	await chat.goto();
	await chat.waitForState("idle");
	await chat.login("openai", process.env.OPENAI_API_KEY!);

	let originalId = "";

	await test.step("capture original session id", async () => {
		await chat.send("Reply only with: noted");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		await chat.send("/sessions");
		const sysLocator = chat.messages("system").last();
		await expect(sysLocator).toContainText(/sessions:/);
		const sys = (await sysLocator.textContent()) ?? "";
		const match = sys.match(/\* ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
		expect(match).not.toBeNull();
		originalId = match![1];
	});

	await test.step("/clone returns a new id distinct from original", async () => {
		await chat.send("/clone");
		const sys = chat.messages("system").last();
		await expect(sys).toContainText(/cloned:/);
		const text = (await sys.textContent()) ?? "";
		const match = text.match(/cloned: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
		expect(match).not.toBeNull();
		expect(match![1]).not.toBe(originalId);
	});
});
