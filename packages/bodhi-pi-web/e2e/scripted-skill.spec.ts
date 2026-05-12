import { expect, test } from "./fixtures";
import { loadScenario } from "./helpers/seed";

const BIRTHDAY = "2000-01-01";
const EXPECTED_DAYS = "9624";

test.describe("M11 scripted skill via run_script", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: loadScenario("skills-days-since-birthday"),
		},
	});

	test("/skill:days-since-birthday calls run_script and reports the integer", async ({ chat }) => {
		await test.step("boot", async () => {
			await chat.setup("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");
		});

		await test.step("send the scripted skill invocation", async () => {
			await chat.send(`/skill:days-since-birthday ${BIRTHDAY}`);
			await chat.waitForState("streaming");
			await chat.waitForState("idle");
		});

		await test.step("run_script tool ran", async () => {
			await expect(chat.toolCalls({ name: "run_script" }).first()).toBeVisible();
		});

		await test.step("assistant replies with the expected day count", async () => {
			expect(await chat.lastMessage("assistant")).toContain(EXPECTED_DAYS);
		});
	});
});
