import { test } from "./fixtures";

test("connects with valid bearer token and renders agent name", async ({ app }) => {
	await app.goto();
	await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
	await app.clickConnect();
	await app.expectStatus("connected");
	await app.expectAgentName("bodhi-pi-ws");
});

test("rejects connection when token is not sent", async ({ app }) => {
	await app.goto();
	await app.setSettings({ email: "bob@example.com", id: 2, sendToken: false });
	await app.clickConnect();
	await app.expectStatus("unauthorized");
});
