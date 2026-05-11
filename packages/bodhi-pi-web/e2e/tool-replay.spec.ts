import { expect, test } from "./fixtures";

test.describe("M15 tool-call replay across /resume", () => {
	test.use({ workspaceSeed: { name: "demo", files: {} } });

	test("write tool_call replays as a completed card after /resume", async ({ chat }) => {
		await test.step("boot to idle", async () => {
			await chat.goto();
			await chat.waitForState("idle");
			await chat.login("openai", process.env.OPENAI_API_KEY!);
		});

		await test.step("session A: write a file (creates a tool_call entry)", async () => {
			await chat.send(
				"Use the write tool to create /mnt/demo/note.txt with content 'persisted'. " +
					"After the write, reply with exactly: ok",
			);
			await chat.waitForState("streaming");
			await chat.waitForState("idle");
			await expect(chat.toolCalls({ name: "write", status: "completed" })).toHaveCount(1);
		});

		let sessionA = "";
		await test.step("capture sessionId from /sessions", async () => {
			await chat.send("/sessions");
			const sysLocator = chat.messages("system").last();
			await expect(sysLocator).toContainText(/sessions:/);
			const sys = (await sysLocator.textContent()) ?? "";
			const match = sys.match(/\* ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
			expect(match).not.toBeNull();
			sessionA = match![1];
		});

		await test.step("/new clears the tool-call cards", async () => {
			await chat.send("/new");
			await chat.waitForState("idle");
			// Auto-retrying assertion: clear() + the subsequent system message
			// land in two React commits; toHaveCount waits for the steady state.
			await expect(chat.toolCalls()).toHaveCount(0);
		});

		await test.step("/resume A replays the write tool_call as completed", async () => {
			await chat.send(`/resume ${sessionA}`);
			await chat.waitForState("idle");
			await expect(chat.toolCalls({ name: "write", status: "completed" })).toHaveCount(1);
		});
	});
});
