import { expect, test } from "./fixtures";
import { loadScenario } from "./helpers/seed";

test.describe("browser extension loader", () => {
	test.use({
		workspaceSeed: {
			name: "ext-demo",
			files: loadScenario("extensions-redact-secrets"),
		},
	});

	test("loads extension via createBrowserExtensionLoader and applies redact-secrets to a real LLM tool turn", async ({
		chat,
		page,
	}) => {
		await test.step("boot lands on idle state", async () => {
			await chat.setup("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");
		});

		await test.step("send a prompt that triggers the read tool on /leak.txt", async () => {
			await chat.send("Read the file leak.txt and tell me what's there verbatim.");
			await chat.waitForState("streaming");
			await chat.waitForState("idle");
		});

		await test.step("the tool-call card shows redacted text, not the original secret", async () => {
			const toolCard = page.locator('[data-testid="tool-call"][data-tool-name="read"]').first();
			await expect(toolCard).toContainText("[REDACTED]");
			await expect(toolCard).not.toContainText("sk-PLAINTEXTSECRETXYZ123");
		});
	});
});
