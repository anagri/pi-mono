import { expect, test } from "./fixtures";

const ECHO_TEMPLATE = [
	"---",
	"description: Echo a word",
	"argument-hint: <word>",
	"---",
	"Reply with exactly the single word: $1",
	"And nothing else.",
].join("\n");

const SAY_TUESDAY_TEMPLATE = [
	"---",
	"description: Say tuesday",
	"---",
	'Reply with exactly the single word "tuesday" and nothing else.',
].join("\n");

test.describe("M9 project slash commands", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: {
				"/.bodhi-pi/commands/echo.md": ECHO_TEMPLATE,
				"/.bodhi-pi/commands/say-tuesday.md": SAY_TUESDAY_TEMPLATE,
			},
		},
	});

	test("/<known> arg expands $1 and reaches the model", async ({ chat }) => {
		await test.step("boot", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
		});

		await test.step("/help advertises echo and say-tuesday", async () => {
			await chat.send("/help");
			const sys = chat.messages("system").last();
			await expect(sys).toContainText("echo");
			await expect(sys).toContainText("say-tuesday");
		});

		await test.step("/echo banana yields banana", async () => {
			await chat.send("/echo banana");
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 60_000);
			expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("banana");
		});

		await test.step("/say-tuesday yields tuesday", async () => {
			await chat.send("/say-tuesday");
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 60_000);
			expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("tuesday");
		});
	});
});

test.describe("M9 unknown slash command falls through", () => {
	test.use({ workspaceSeed: { name: "demo", files: {} } });

	test("/<unknown> passes through verbatim", async ({ chat }) => {
		await chat.goto();
		await chat.waitForState("idle", 60_000);
		await chat.send("/totally-not-a-command Reply with the single word: gravy");
		await chat.waitForState("streaming");
		await chat.waitForState("idle", 60_000);
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("gravy");
	});
});
