import { expect, test } from "./fixtures";

test.describe("M8 scripted skill (run_script)", () => {
	test.use({ scenario: "skills-days-since-birthday" });

	test("/skill:days-since-birthday invokes run_script and returns the integer", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("/new");

		// Skill instructs the agent to call run_script with the date argument.
		// Baseline date in script.js is 2026-05-08; pick a fixed input date so we
		// know the expected integer.
		await app.send("/skill:days-since-birthday 2025-05-08");
		await app.expectChatStatus("idle");

		// Tool-call card with run_script status=completed should be visible.
		const completed = app.toolCalls({ status: "completed" });
		await expect(completed.first()).toBeVisible();

		const out = (await app.lastMessageText("assistant")).trim();
		// Roughly one year of days between 2025-05-08 and 2026-05-08; assert non-empty integer.
		expect(out).toMatch(/^\d+$/);
		expect(Number(out)).toBeGreaterThan(300);
		expect(Number(out)).toBeLessThan(400);
	});
});
