import { expect, test } from "./fixtures";

test("real-LLM prompt triggers a tool-call card", async ({ app }) => {
	await app.goto();
	await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
	await app.clickConnect();
	await app.expectStatus("connected");

	// Prompt the agent to write a file — exercises the write_text_file tool, which the
	// builtin toolset registers when bodhi-pi sees a Filesystem at boot.
	await app.send("Create a file named greeting.txt in the current directory with the text 'hello'.");
	await app.expectChatStatus("streaming");
	await app.expectChatStatus("idle");

	// At least one tool-call card lands; status reaches completed (or failed). Assert the
	// terminal-state card rather than a specific tool name to stay robust to which built-in
	// tool the model picks.
	const completed = app.toolCalls({ status: "completed" });
	await expect(completed.first()).toBeVisible();
});
