import { expect, test } from "./fixtures";

test("/name + /session + /export through the chat UI", async ({ chat, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await chat.goto();
	await chat.waitForState("idle");

	await test.step("seed a turn", async () => {
		await chat.send("Reply only with: hello");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
	});

	await test.step("/name sets the display name", async () => {
		await chat.send("/name my-fork");
		await expect(chat.messages("system").last()).toContainText(/session name set to: my-fork/);
	});

	await test.step("/session reports stats including the name", async () => {
		await chat.send("/session");
		const sys = chat.messages("system").last();
		await expect(sys).toContainText(/name: my-fork/);
		await expect(sys).toContainText(/messages:/);
		await expect(sys).toContainText(/leaf:/);
	});

	await test.step("/export confirms it copied to clipboard", async () => {
		await chat.send("/export");
		const sys = chat.messages("system").last();
		await expect(sys).toContainText(/exported \(jsonl/);
	});
});
