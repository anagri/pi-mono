import { expect, test } from "./fixtures";

test.describe("M15 tool-failure rendering", () => {
	test.use({ workspaceSeed: { name: "demo", files: {} } });

	test("a failed read tool surfaces as a failed card", async ({ chat }) => {
		await test.step("boot to idle on empty workspace", async () => {
			await chat.setup("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");
		});

		await test.step("ask agent to read a missing file", async () => {
			await chat.send(
				"Use the read tool to read /mnt/demo/missing.txt. " +
					"That file does NOT exist, so the read MUST fail. " +
					"After the failure, reply with exactly the words: file-missing",
			);
			await chat.waitForState("streaming");
			await chat.waitForState("idle");
		});

		await test.step("read tool card lands as failed", async () => {
			await expect(chat.toolCalls({ name: "read", status: "failed" })).toHaveCount(1);
		});

		await test.step("assistant follows up with the agreed phrase", async () => {
			expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("file-missing");
		});
	});
});
