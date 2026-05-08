import { expect, test } from "./fixtures";

const REDACT_SECRETS_JS = `export default function (pi) {
	pi.on("tool_result", (event) => {
		const newContent = event.result.content.map((b) =>
			b.type === "text" ? { ...b, text: b.text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]") } : b
		);
		const changed = newContent.some((b, i) => b !== event.result.content[i]);
		return changed ? { content: newContent } : undefined;
	});
}
`;

test.describe("browser extension loader", () => {
	test.use({
		workspaceSeed: {
			name: "ext-demo",
			files: {
				"/leak.txt": "the API_KEY is sk-PLAINTEXTSECRETXYZ123 — keep secret",
				"/.bodhi-pi/extensions/redact-secrets.js": REDACT_SECRETS_JS,
			},
		},
	});

	test("loads extension via createBrowserExtensionLoader and applies redact-secrets to a real LLM tool turn", async ({
		chat,
		page,
	}) => {
		await test.step("boot lands on idle state", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
		});

		await test.step("send a prompt that triggers the read tool on /leak.txt", async () => {
			await chat.send("Read the file leak.txt and tell me what's there verbatim.");
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 60_000);
		});

		await test.step("the tool-call card shows redacted text, not the original secret", async () => {
			const toolCard = page.locator('[data-testid="tool-call"][data-tool-name="read"]').first();
			await expect(toolCard).toContainText("[REDACTED]");
			await expect(toolCard).not.toContainText("sk-PLAINTEXTSECRETXYZ123");
		});
	});
});
