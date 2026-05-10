import { expect, test } from "./fixtures";

test.describe("M10 fs tools surface tool-call cards", () => {
	test.describe("write + read", () => {
		test("agent writes a file then reads it back", async ({ app }) => {
			await app.goto();
			await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
			await app.clickConnect();
			await app.expectStatus("connected");

			await app.send(
				"Step 1: use the write tool to create a file named poem.txt with the content 'roses are red'. " +
					"Step 2: use the read tool to read poem.txt. " +
					"Step 3: reply with the file's content verbatim.",
			);
			await app.expectChatStatus("streaming");
			await app.expectChatStatus("idle");

			await expect(app.toolCalls({ name: "write" }).first()).toHaveAttribute("data-tool-status", "completed");
			await expect(app.toolCalls({ name: "read" }).first()).toHaveAttribute("data-tool-status", "completed");
			expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("roses are red");
		});
	});

	test.describe("edit replaces a substring", () => {
		test.use({ scenario: "fs-tools-notes-txt" });

		test("agent edits a file and verifies via read", async ({ app }) => {
			await app.goto();
			await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
			await app.clickConnect();
			await app.expectStatus("connected");

			await app.send(
				"Step 1: use the edit tool to change notes.txt — replace the substring 'world' with 'earth'. " +
					"Step 2: use the read tool to read notes.txt. " +
					"Step 3: reply with the resulting file content verbatim and nothing else.",
			);
			await app.expectChatStatus("streaming");
			await app.expectChatStatus("idle");

			await expect(app.toolCalls({ name: "edit" }).first()).toHaveAttribute("data-tool-status", "completed");
			await expect(app.toolCalls({ name: "read" }).first()).toHaveAttribute("data-tool-status", "completed");
			expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("hello earth");
		});
	});

	test.describe("ls lists directory entries", () => {
		test.use({ scenario: "fs-tools-notes-abc" });

		test("agent lists notes/", async ({ app }) => {
			await app.goto();
			await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
			await app.clickConnect();
			await app.expectStatus("connected");

			await app.send(
				"Use the ls tool to list the contents of the notes directory. " +
					"Reply with the filenames separated by single spaces and nothing else.",
			);
			await app.expectChatStatus("streaming");
			await app.expectChatStatus("idle");

			await expect(app.toolCalls({ name: "ls" }).first()).toHaveAttribute("data-tool-status", "completed");
			const reply = (await app.lastMessageText("assistant")).toLowerCase();
			expect(reply).toContain("alpha.md");
			expect(reply).toContain("beta.md");
			expect(reply).toContain("gamma.md");
		});
	});

	test.describe("grep finds the codeword", () => {
		test.use({ scenario: "fs-tools-codeword" });

		test("agent greps for a codeword and surfaces the result in the tool card preview", async ({ app }) => {
			await app.goto();
			await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
			await app.clickConnect();
			await app.expectStatus("connected");

			await app.send(
				"Use the grep tool with a regex to find which file under notes mentions 'codeword'. " +
					"Then reply with the codeword value only and nothing else.",
			);
			await app.expectChatStatus("streaming");
			await app.expectChatStatus("idle");

			const grepCard = app.toolCalls({ name: "grep" }).first();
			await expect(grepCard).toHaveAttribute("data-tool-status", "completed");
			await expect(grepCard.getByTestId("tool-call-preview")).toContainText("parrot");
			expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("parrot");
		});
	});

	test.describe("find returns matching files", () => {
		test.use({ scenario: "fs-tools-docs-tree" });

		test("agent finds .md files under the workspace", async ({ app }) => {
			await app.goto();
			await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
			await app.clickConnect();
			await app.expectStatus("connected");

			await app.send(
				"Use the find tool (NOT grep, NOT ls) to find every file in the current workspace whose name ends in '.md'. " +
					"Reply with just the integer count of .md files and nothing else.",
			);
			await app.expectChatStatus("streaming");
			await app.expectChatStatus("idle");

			await expect(app.toolCalls({ name: "find" }).first()).toHaveAttribute("data-tool-status", "completed");
			// Two .md files seeded: docs/intro.md and docs/notes/draft.md.
			expect(await app.lastMessageText("assistant")).toMatch(/\b2\b/);
		});
	});
});
