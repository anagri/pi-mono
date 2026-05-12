import { expect, test } from "./fixtures";

test.describe("M13 /compact (manual) — ws split host", () => {
	test("compacts after multi-turn history; subsequent prompt still answers about earlier fact", async ({ app }) => {
		await app.setup("gpt-4o-mini", { email: "alice@example.com", id: 1, sendToken: true });

		await app.send("Remember: my pet's name is Mango. Reply only with: noted");
		await app.expectChatStatus("idle");
		expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("noted");

		await app.send("Reply with one short sentence: what comes after Tuesday?");
		await app.expectChatStatus("idle");

		await app.send("/compact");
		await expect(app.page.getByTestId("system-message").last()).toContainText(/compacted/);

		await app.send("What is my pet's name? Reply with the single word.");
		await app.expectChatStatus("idle");
		expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("mango");
	});
});
