import { expect, test } from "./fixtures";

test("M2 echo round trip", async ({ chat }) => {
	await test.step("boot lands on echo state", async () => {
		await chat.goto();
		await chat.waitForState("echo");
		await expect(chat.statusBar).toHaveAttribute("data-current-model", "echo");
	});

	await test.step("send first message", async () => {
		await chat.send("hello");
	});

	await test.step("user message lands", async () => {
		expect(await chat.lastMessage("user")).toBe("hello");
	});

	await test.step("echo response lands", async () => {
		expect(await chat.lastMessage("assistant")).toBe("echo: hello");
	});

	await test.step("second turn keeps history intact", async () => {
		await chat.send("again");
		expect(await chat.messages("user").count()).toBe(2);
		expect(await chat.lastMessage("assistant")).toBe("echo: again");
	});
});
