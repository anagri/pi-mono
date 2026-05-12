import { expect, test } from "./fixtures.js";

test.describe("auth (Authorization: Bearer)", () => {
	test("sendToken=false → state=unauthorized", async ({ app }) => {
		await app.goto();
		await app.setSettings({ sendToken: false });
		await app.clickConnect();
		await app.expectStatus("unauthorized");
		await app.expectChatState("unauthorized");
	});

	test("valid token → state=connected", async ({ app }) => {
		await app.connect();
		await expect(app.chatPage).toHaveAttribute("data-test-state", "idle");
	});

	test("disconnect returns state to disconnected", async ({ app }) => {
		await app.connect();
		await app.clickDisconnect();
		await app.expectStatus("disconnected");
	});
});
