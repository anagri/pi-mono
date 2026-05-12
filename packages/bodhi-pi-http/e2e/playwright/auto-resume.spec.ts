import { expect, test } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

test.describe("auto-resume on page reload (real LLM)", () => {
	test.skip(!HAS_KEY, "requires OPENAI_API_KEY");

	test("reloading the page restores the prior sessionId via lastSession storage", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("Reply with the single word: alpha");
		await app.expectChatStatus("idle");
		const sessionId = await app.status.getAttribute("data-session-id");
		expect(sessionId).toBeTruthy();

		await app.page.reload();
		await app.clickConnect();
		await app.expectStatus("connected");
		await expect(app.status).toHaveAttribute("data-session-id", sessionId ?? "");
	});

	test("different userId after disconnect → fresh session (tenant-scoped key)", async ({ app }) => {
		await app.connect({ id: 220 });
		await app.model("gpt-4o-mini");
		await app.send("Reply with the single word: bravo");
		await app.expectChatStatus("idle");
		const initialSessionId = await app.status.getAttribute("data-session-id");

		await app.clickDisconnect();
		await app.expectStatus("disconnected");

		await app.setSettings({ id: 221 });
		await app.clickConnect();
		await app.expectStatus("connected");
		await expect(app.status).not.toHaveAttribute("data-session-id", initialSessionId ?? "");
	});

	test("stale stored sessionId → fall back to a fresh session", async ({ app }) => {
		await app.goto();
		await app.setSettings();

		await app.page.evaluate(
			([userId]) => {
				const w = globalThis as unknown as {
					location: { origin: string };
					localStorage: { setItem: (k: string, v: string) => void };
				};
				w.localStorage.setItem(
					`bodhi-pi-http:lastSession:${w.location.origin}:${userId}`,
					"session-does-not-exist-xyz",
				);
			},
			[String(app.tenant.id)],
		);

		await app.clickConnect();
		await app.expectStatus("connected");

		await expect(app.status).not.toHaveAttribute("data-session-id", "");
		const realSessionId = await app.status.getAttribute("data-session-id");
		expect(realSessionId).toBeTruthy();
		expect(realSessionId).not.toBe("session-does-not-exist-xyz");

		const stored = await app.page.evaluate(
			([userId]) => {
				const w = globalThis as unknown as {
					location: { origin: string };
					localStorage: { getItem: (k: string) => string | null };
				};
				return w.localStorage.getItem(`bodhi-pi-http:lastSession:${w.location.origin}:${userId}`);
			},
			[String(app.tenant.id)],
		);
		expect(stored).toBe(realSessionId);
	});
});
