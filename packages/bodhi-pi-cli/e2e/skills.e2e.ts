import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { loadFixture, seedWorkspace } from "@test/helpers/seed-workspace.js";
import { afterEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

afterEach(async () => {
	await harness?.cleanup();
});

test("/skill:<name> arg expands and reaches the model with the skill body", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	await seedWorkspace(harness.tmpDir, {
		skills: { "say-hello/SKILL.md": await loadFixture("skills-say-hello/.bodhi-pi/skills/say-hello/SKILL.md") },
	});

	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });
	await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "/skill:say-hello world" }] });

	expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("hello, world");
});

test("disable-model-invocation skills are advertised via available_commands_update so /skill:<name> stays usable", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	// Mirror web/e2e/skills.spec.ts M16: a hidden-from-model skill must still
	// land in available_commands_update so the user can invoke it explicitly via
	// `/skill:<name>`. The actual scripted execution is exercised in
	// scripted-skill.e2e.ts; here we just prove discoverability.
	await seedWorkspace(harness.tmpDir, {
		skills: {
			"days-since-birthday/SKILL.md": [
				"---",
				"description: Compute days between a YYYY-MM-DD birthday and the baseline.",
				"disable-model-invocation: true",
				"---",
				"placeholder body — execution is covered by scripted-skill.e2e.ts.",
			].join("\n"),
		},
	});

	await harness.client.initialize(stdInitParams);
	await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	const update = harness.updates.find((u) => u.update.sessionUpdate === "available_commands_update");
	expect(update, "expected available_commands_update on session/new").toBeDefined();
	const names = ((update?.update as { availableCommands?: Array<{ name: string }> }).availableCommands ?? []).map(
		(c) => c.name,
	);
	expect(names, `available commands: ${names.join(", ")}`).toContain("skill:days-since-birthday");
});

test("unknown /skill:<name> falls through to the LLM as a plain prompt", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });

	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });
	const result = await harness.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "/skill:nonexistent please answer with the single word: pong" }],
	});

	expect(result.stopReason).toBe("end_turn");
	expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("pong");
});
