import { expect, test } from "./fixtures";
import { loadScenario } from "./helpers/seed";

test.describe("M9 project slash commands", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: { ...loadScenario("commands-echo"), ...loadScenario("commands-say-tuesday") },
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

test.describe("M16 commands re-emit on /resume", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: loadScenario("commands-echo"),
		},
	});

	test("available_commands_update fires again after session/load", async ({ chat }) => {
		await test.step("boot — /help shows the seeded command", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
			await chat.send("/help");
			await expect(chat.messages("system").last()).toContainText("echo");
		});

		let sessionA = "";
		await test.step("capture sessionId from /sessions", async () => {
			await chat.send("/sessions");
			const sysLocator = chat.messages("system").last();
			await expect(sysLocator).toContainText(/sessions:/);
			const sys = (await sysLocator.textContent()) ?? "";
			const match = sys.match(/\* ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
			expect(match).not.toBeNull();
			sessionA = match![1];
		});

		await test.step("/new wipes per-session command list, /help shows none", async () => {
			await chat.send("/new");
			await chat.waitForState("idle", 60_000);
			await chat.send("/help");
			// Same command file, same workspace → new session re-runs discovery
			// against /mnt/demo/.bodhi-pi/commands. /help should still list echo.
			await expect(chat.messages("system").last()).toContainText("echo");
		});

		await test.step("/resume A re-emits available_commands_update", async () => {
			await chat.send(`/resume ${sessionA}`);
			await chat.waitForState("idle", 60_000);
			await chat.send("/help");
			// Proves bodhi-pi's loadSession path re-runs command discovery and
			// emits available_commands_update — render.ts repopulates the
			// availableCommands state, /help reads it.
			await expect(chat.messages("system").last()).toContainText("echo");
		});
	});
});
