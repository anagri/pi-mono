import { expect, test } from "./fixtures";

test.describe("M16 model_change persists across /resume", () => {
	test.use({ workspaceSeed: { name: "demo", files: {} } });

	test("status bar reflects the prior model after /new + /resume", async ({ chat }) => {
		await test.step("boot, login, select gpt-4o-mini", async () => {
			await chat.setup("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");
		});

		await test.step("/model gpt-4o + one turn so model_change is persisted", async () => {
			await chat.model("gpt-4o");
			await chat.send("Reply with the single word: alpha");
			await chat.waitForState("streaming");
			await chat.waitForState("idle");
		});

		let sessionA = "";
		await test.step("capture sessionId via /sessions", async () => {
			await chat.send("/sessions");
			// Auto-retry: chat.send doesn't await the handler — wait for the
			// "sessions:" listing to actually render before reading text.
			const sysLocator = chat.messages("system").last();
			await expect(sysLocator).toContainText(/sessions:/);
			const sys = (await sysLocator.textContent()) ?? "";
			const match = sys.match(/\* ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
			expect(match).not.toBeNull();
			sessionA = match![1];
		});

		await test.step("/new starts a fresh session not pinned to gpt-4o", async () => {
			await chat.send("/new");
			await chat.waitForState("idle");
			await expect(chat.statusBar).not.toHaveAttribute("data-current-model", "gpt-4o");
		});

		await test.step("/resume A restores gpt-4o", async () => {
			await chat.send(`/resume ${sessionA}`);
			await chat.waitForState("idle");
			// loadSession's response carries configOptions[0].currentValue =
			// the latest model_change entry. commands.ts:/resume reads it and
			// calls setCurrentModelId — status bar's data-current-model flips.
			await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o");
		});
	});
});
