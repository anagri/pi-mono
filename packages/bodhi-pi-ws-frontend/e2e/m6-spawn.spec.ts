import { expect, test } from "./fixtures";

test("spawned ws-server: connect via UI Settings.serverUrl", async ({ app, testServer }) => {
	await app.goto();
	// Auto-filled URL should match the fixture-spawned server.
	await expect(app.page.getByTestId("settings-serverUrl")).toHaveValue(testServer.url);

	await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
	await app.clickConnect();
	await app.expectStatus("connected");
	await app.expectAgentName("bodhi-pi");
});
