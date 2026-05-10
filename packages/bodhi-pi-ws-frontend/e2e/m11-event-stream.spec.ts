import { expect, test } from "./fixtures";

test.describe("M11 event stream panel", () => {
	test("captures the initialize handshake on connect", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "m11-events@example.com", id: 110, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		const panel = app.page.getByTestId("event-stream-panel");
		await expect(panel).toBeVisible();

		// Outbound initialize request and inbound response should both appear.
		await expect(
			panel.locator('[data-testid="event-row"][data-direction="outbound"][data-method="initialize"]'),
		).toHaveCount(1);
		await expect(
			panel.locator('[data-testid="event-row"][data-direction="inbound"][data-method="response"]'),
		).not.toHaveCount(0);
	});

	test("captures session/prompt + agent_message_chunk frames around a prompt", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "m11-events@example.com", id: 111, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("Reply with the single word: pong");
		await app.expectChatStatus("idle");

		const panel = app.page.getByTestId("event-stream-panel");

		await expect(
			panel.locator('[data-testid="event-row"][data-direction="outbound"][data-method="session/prompt"]'),
		).not.toHaveCount(0);
		await expect(
			panel.locator('[data-testid="event-row"][data-direction="inbound"][data-kind="agent_message_chunk"]').first(),
		).toBeVisible();
	});

	test("hides the panel when disconnected", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "m11-events@example.com", id: 112, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await expect(app.page.getByTestId("event-stream-panel")).toBeVisible();

		await app.page.getByTestId("disconnect").click();
		await app.expectStatus("disconnected");
		await expect(app.page.getByTestId("event-stream-panel")).toHaveCount(0);
	});
});
