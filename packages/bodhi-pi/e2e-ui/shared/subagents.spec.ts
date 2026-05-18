import { expect, test } from "../fixtures.ts";
import { buildSeedXml } from "../helpers/seed-xml.ts";

test("subagent: /agents lists the profile and /subagent <name> <task> reports the summary", async ({
	startApp,
	chat,
}) => {
	const files = {
		"doc.md": "The quick brown fox jumps over the lazy dog.",
		".bodhi-pi/agents/extractor.md": [
			"---",
			"name: extractor",
			"description: Read a file and return a one-sentence summary.",
			"tools:",
			"  - read",
			"---",
			"You are an extractor sub-agent. The task you receive contains a file path (relative or absolute). Use the `read` tool to read that file (relative paths are resolved against the current working directory), then reply with a single short sentence summarizing the file content. Do not write, edit, or run scripts.",
		].join("\n"),
	};

	await startApp({ seedXml: buildSeedXml(files) });

	await chat.send("/agents");
	const listMsg = chat.root.locator('[data-subagent-event="list"]');
	await expect(listMsg).toBeVisible({ timeout: 30_000 });
	await expect(listMsg).toContainText("extractor");

	await chat.send("/subagent extractor summarize doc.md");
	const resultMsg = chat.root.locator('[data-subagent-event="run-result"]');
	// extMethod is fire-and-await; wait up to 120s for the local slash handler to
	// receive the run result and push the system message into the chat panel.
	await expect(resultMsg).toBeVisible({ timeout: 120_000 });
	await expect(resultMsg).toHaveAttribute("data-subagent-status", "completed");
	await expect(resultMsg).toHaveAttribute("data-subagent-name", "extractor");
	await expect(resultMsg).toContainText(/fox/i);
});
