import { expect, test } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

test.describe("scripted skill via run_script (real LLM)", () => {
	test.skip(!HAS_KEY, "requires OPENAI_API_KEY");
	test.use({ scenario: "skills-days-since-birthday" });

	test("/skill:days-since-birthday invokes run_script and returns an integer", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("/new");

		await app.send("/skill:days-since-birthday 2025-05-08");
		await app.expectChatStatus("idle");

		// Tool-call card for run_script reaches completed status.
		const completed = app.toolCalls({ status: "completed" });
		await expect(completed.first()).toBeVisible();

		const last = app.page.locator('[data-testid="message"][data-role="assistant"]').last();
		// Skill computes days between input date and a fixed baseline. Roughly one
		// year (2025-05-08 → baseline) — assert the integer falls in a sensible range.
		await expect(last).toHaveText(/^agent:\s*\d+\s*$/);
		const text = (await last.innerText()).replace(/^agent:\s*/, "").trim();
		const n = Number(text);
		expect(n).toBeGreaterThan(300);
		expect(n).toBeLessThan(400);
	});
});
