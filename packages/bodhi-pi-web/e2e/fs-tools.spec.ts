import { expect, test } from "./fixtures";

test.describe("M8 FS tools surface tool-call cards", () => {
	test.describe("write + read", () => {
		test.use({ workspaceSeed: { name: "demo", files: {} } });

		test("agent writes a file then reads it back", async ({ chat }) => {
			await test.step("boot", async () => {
				await chat.goto();
				await chat.waitForState("idle", 60_000);
			});

			await test.step("send write+read prompt", async () => {
				await chat.send(
					"Step 1: use the write tool to create /mnt/demo/poem.txt with the content 'roses are red'. " +
						"Step 2: use the read tool to read /mnt/demo/poem.txt. " +
						"Step 3: reply with the file's content verbatim.",
				);
				await chat.waitForState("streaming");
				await chat.waitForState("idle", 90_000);
			});

			await test.step("write tool ran and completed", async () => {
				await expect(chat.toolCalls({ name: "write" }).first()).toHaveAttribute("data-tool-status", "completed");
			});

			await test.step("read tool ran and completed", async () => {
				await expect(chat.toolCalls({ name: "read" }).first()).toHaveAttribute("data-tool-status", "completed");
			});

			await test.step("assistant echoes file content", async () => {
				expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("roses are red");
			});
		});
	});

	test.describe("grep over seeded files", () => {
		test.use({
			workspaceSeed: {
				name: "demo",
				files: {
					"/notes/a.md": "# A\nthe codeword is parrot\n",
					"/notes/b.md": "# B\njust a draft\n",
				},
			},
		});

		test("agent greps for a codeword", async ({ chat }) => {
			await test.step("boot", async () => {
				await chat.goto();
				await chat.waitForState("idle", 60_000);
			});

			await test.step("send grep prompt", async () => {
				await chat.send(
					"Use the grep tool with a regex to find which file under /mnt/demo/notes mentions 'codeword'. " +
						"Then reply with the codeword value only and nothing else.",
				);
				await chat.waitForState("streaming");
				await chat.waitForState("idle", 90_000);
			});

			await test.step("grep tool surfaced as a card", async () => {
				await expect(chat.toolCalls({ name: "grep" }).first()).toBeVisible();
			});

			await test.step("assistant identifies the codeword", async () => {
				expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("parrot");
			});
		});
	});
});
