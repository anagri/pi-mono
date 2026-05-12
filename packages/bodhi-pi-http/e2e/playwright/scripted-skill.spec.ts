import { expect, test } from "./fixtures.js";

test.describe("scripted skill via run_script (real LLM)", () => {
	test.use({ scenario: "skills-days-since-birthday" });

	test("/skill:days-since-birthday invokes run_script and returns an integer", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("/skill:days-since-birthday 2025-05-08");
		await app.expectChatStatus("idle");

		const completed = app.toolCalls({ status: "completed" });
		await expect(completed.first()).toBeVisible();

		const last = app.page.locator('[data-testid="message"][data-role="assistant"]').last();
		await expect(last).toHaveText(/^agent:\s*\d+\s*$/);
		const text = (await last.innerText()).replace(/^agent:\s*/, "").trim();
		const n = Number(text);
		expect(n).toBeGreaterThan(300);
		expect(n).toBeLessThan(400);
	});
});
