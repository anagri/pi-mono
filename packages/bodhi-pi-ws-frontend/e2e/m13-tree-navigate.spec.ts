import { expect, test } from "./fixtures";

test.describe("M13 /tree + /goto — ws split host", () => {
	test("/tree lists entries with a single leaf marker; /goto rewinds and next prompt branches from there", async ({
		app,
	}) => {
		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("/new");
		await expect(app.page.getByTestId("system-message").last()).toContainText("new session");

		await app.send("Reply only with: first");
		await app.expectChatStatus("idle");
		await app.send("Reply only with: second");
		await app.expectChatStatus("idle");

		await app.send("/tree");
		const treeSys = app.page.getByTestId("system-message").last();
		await expect(treeSys).toContainText(/tree:/);
		const treeText = (await treeSys.textContent()) ?? "";
		const leafLines = treeText.split("\n").filter((l) => l.startsWith("*"));
		expect(leafLines.length).toBe(1);

		await app.send("/entries");
		const entriesSys = app.page.getByTestId("system-message").last();
		await expect(entriesSys).toContainText(/entries:/);
		const entriesText = (await entriesSys.textContent()) ?? "";
		const matches = [
			...entriesText.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+user/g),
		];
		expect(matches.length).toBe(2);
		const firstUserId = matches[0][1];

		await app.send(`/goto ${firstUserId}`);
		await expect(app.page.getByTestId("system-message").last()).toContainText(/leaf moved to/);

		await app.send("Reply only with: branch");
		await app.expectChatStatus("idle");

		await app.send("/entries");
		const afterSys = app.page.getByTestId("system-message").last();
		await expect(afterSys).toContainText(/entries:/);
		const afterText = ((await afterSys.textContent()) ?? "").toLowerCase();
		expect(afterText).toContain("first");
		expect(afterText).toContain("branch");
		expect(afterText).not.toContain("second");
	});
});
