import { expect, test } from "./fixtures";
import { loadScenario } from "./helpers/seed";

test.describe("M8 FS tools surface tool-call cards", () => {
	test.describe("write + read", () => {
		test.use({ workspaceSeed: { name: "demo", files: {} } });

		test("agent writes a file then reads it back", async ({ chat }) => {
			await test.step("boot", async () => {
				await chat.goto();
				await chat.waitForState("idle");
				await chat.login("openai", process.env.OPENAI_API_KEY!);
			});

			await test.step("send write+read prompt", async () => {
				await chat.send(
					"Step 1: use the write tool to create /mnt/demo/poem.txt with the content 'roses are red'. " +
						"Step 2: use the read tool to read /mnt/demo/poem.txt. " +
						"Step 3: reply with the file's content verbatim.",
				);
				await chat.waitForState("streaming");
				await chat.waitForState("idle");
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

	test.describe("edit replaces a substring", () => {
		test.use({
			workspaceSeed: {
				name: "demo",
				files: loadScenario("fs-tools-notes-txt"),
			},
		});

		test("agent edits a file and verifies via read", async ({ chat }) => {
			await test.step("boot", async () => {
				await chat.goto();
				await chat.waitForState("idle");
				await chat.login("openai", process.env.OPENAI_API_KEY!);
			});

			await test.step("send edit+read prompt", async () => {
				await chat.send(
					"Step 1: use the edit tool to change /mnt/demo/notes.txt — replace the substring 'world' with 'earth'. " +
						"Step 2: use the read tool to read /mnt/demo/notes.txt. " +
						"Step 3: reply with the resulting file content verbatim and nothing else.",
				);
				await chat.waitForState("streaming");
				await chat.waitForState("idle");
			});

			await test.step("edit tool ran and completed", async () => {
				await expect(chat.toolCalls({ name: "edit" }).first()).toHaveAttribute("data-tool-status", "completed");
			});

			await test.step("read tool ran and completed", async () => {
				await expect(chat.toolCalls({ name: "read" }).first()).toHaveAttribute("data-tool-status", "completed");
			});

			await test.step("assistant echoes 'hello earth'", async () => {
				expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("hello earth");
			});
		});
	});

	test.describe("ls lists directory entries", () => {
		test.use({
			workspaceSeed: {
				name: "demo",
				files: loadScenario("fs-tools-notes-abc"),
			},
		});

		test("agent lists three seeded files", async ({ chat }) => {
			await test.step("boot", async () => {
				await chat.goto();
				await chat.waitForState("idle");
				await chat.login("openai", process.env.OPENAI_API_KEY!);
			});

			await test.step("send ls prompt", async () => {
				await chat.send(
					"Use the ls tool to list the contents of /mnt/demo/notes. " +
						"Reply with the filenames separated by single spaces and nothing else.",
				);
				await chat.waitForState("streaming");
				await chat.waitForState("idle");
			});

			await test.step("ls tool ran and completed", async () => {
				await expect(chat.toolCalls({ name: "ls" }).first()).toHaveAttribute("data-tool-status", "completed");
			});

			await test.step("assistant mentions all three files", async () => {
				const reply = (await chat.lastMessage("assistant")).toLowerCase();
				expect(reply).toContain("alpha.md");
				expect(reply).toContain("beta.md");
				expect(reply).toContain("gamma.md");
			});
		});
	});

	test.describe("find returns matching files", () => {
		test.use({
			workspaceSeed: {
				name: "demo",
				files: loadScenario("fs-tools-docs-tree"),
			},
		});

		test("agent finds .md files under /mnt/demo", async ({ chat }) => {
			await test.step("boot", async () => {
				await chat.goto();
				await chat.waitForState("idle");
				await chat.login("openai", process.env.OPENAI_API_KEY!);
			});

			await test.step("send find prompt", async () => {
				await chat.send(
					"Use the find tool (NOT grep, NOT ls) to find every file under /mnt/demo whose name ends in '.md'. " +
						"Reply with just the integer count of .md files and nothing else.",
				);
				await chat.waitForState("streaming");
				await chat.waitForState("idle");
			});

			await test.step("find tool ran and completed", async () => {
				await expect(chat.toolCalls({ name: "find" }).first()).toHaveAttribute("data-tool-status", "completed");
			});

			await test.step("assistant reports the count 2", async () => {
				expect(await chat.lastMessage("assistant")).toMatch(/\b2\b/);
			});
		});
	});

	test.describe("grep over seeded files", () => {
		test.use({
			workspaceSeed: {
				name: "demo",
				files: loadScenario("fs-tools-codeword"),
			},
		});

		test("agent greps for a codeword", async ({ chat }) => {
			await test.step("boot", async () => {
				await chat.goto();
				await chat.waitForState("idle");
				await chat.login("openai", process.env.OPENAI_API_KEY!);
			});

			await test.step("send grep prompt", async () => {
				await chat.send(
					"Use the grep tool with a regex to find which file under /mnt/demo/notes mentions 'codeword'. " +
						"Then reply with the codeword value only and nothing else.",
				);
				await chat.waitForState("streaming");
				await chat.waitForState("idle");
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
