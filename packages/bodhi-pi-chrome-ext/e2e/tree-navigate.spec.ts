import { expect, test } from "./fixtures";

test("/tree lists all entries with a leaf marker; /goto rewinds the leaf and the next prompt branches from there", async ({
	chat,
}) => {
	await chat.goto();
	await chat.waitForState("idle");

	let firstUserId = "";

	await test.step("seed two turns", async () => {
		await chat.send("Reply only with: first");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		await chat.send("Reply only with: second");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
	});

	await test.step("/tree shows entries with one leaf marker", async () => {
		await chat.send("/tree");
		const sysLocator = chat.messages("system").last();
		await expect(sysLocator).toContainText(/tree:/);
		const text = (await sysLocator.textContent()) ?? "";
		const leafLines = text.split("\n").filter((l) => l.startsWith("*"));
		expect(leafLines.length).toBe(1);
	});

	await test.step("/entries returns the first user message id", async () => {
		await chat.send("/entries");
		const sysLocator = chat.messages("system").last();
		const text = (await sysLocator.textContent()) ?? "";
		const matches = [...text.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+user/g)];
		expect(matches.length).toBe(2);
		firstUserId = matches[0][1];
	});

	await test.step("/goto rewinds; the next prompt branches from the rewound leaf", async () => {
		await chat.send(`/goto ${firstUserId}`);
		await expect(chat.messages("system").last()).toContainText(/leaf moved to/);

		await chat.send("Reply only with: branch");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");

		await chat.send("/entries");
		const sysLocator = chat.messages("system").last();
		await expect(sysLocator).toContainText(/entries:/);
		const text = (await sysLocator.textContent()) ?? "";
		expect(text.toLowerCase()).toContain("first");
		expect(text.toLowerCase()).toContain("branch");
		expect(text.toLowerCase()).not.toContain("second");
	});
});
