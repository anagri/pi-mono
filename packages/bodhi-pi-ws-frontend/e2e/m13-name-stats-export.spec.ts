import { expect, test } from "./fixtures";

test.describe("M13 /name + /session + /export — ws split host", () => {
	test("/name sets the display name; /session reports it; /export reports clipboard copy", async ({
		app,
		context,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("/new");
		await expect(app.page.getByTestId("system-message").last()).toContainText("new session");

		await app.send("Reply only with: hello");
		await app.expectChatStatus("idle");

		await app.send("/name my-fork");
		await expect(app.page.getByTestId("system-message").last()).toContainText(/session name set to: my-fork/);

		await app.send("/session");
		const stats = app.page.getByTestId("system-message").last();
		await expect(stats).toContainText(/name: my-fork/);
		await expect(stats).toContainText(/messages:/);

		await app.send("/export");
		await expect(app.page.getByTestId("system-message").last()).toContainText(/exported \(jsonl/);
	});
});
