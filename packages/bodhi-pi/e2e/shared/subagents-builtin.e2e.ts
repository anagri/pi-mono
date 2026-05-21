import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { loadScenarioFiles } from "../helpers/load-scenario.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

interface ListedProfile {
	name: string;
	description: string;
	source: "project" | "extension" | "builtin";
}

test("built-in profiles are available without any .bodhi-pi/agents/ seed", async () => {
	const model = getModel("anthropic", "claude-haiku-4-5-20251001");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("anthropic"),
		}),
	);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const res = (await h.clientConn.extMethod("_bodhi-pi/subagent/list", { sessionId })) as {
		profiles: ListedProfile[];
	};
	const names = res.profiles.map((p) => p.name).sort();
	expect(names).toEqual(["explore", "planner"]);
	for (const p of res.profiles) expect.soft(p.source).toBe("builtin");
});

test("built-in explore profile spawned via _bodhi-pi/subagent/run reads a seeded file and finds the sentinel", async () => {
	const model = getModel("anthropic", "claude-haiku-4-5-20251001");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("anthropic"),
		}),
	);
	await h.setupFiles(await loadScenarioFiles("subagents-builtin"));

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const result = (await h.clientConn.extMethod("_bodhi-pi/subagent/run", {
		sessionId,
		agent: "explore",
		task: `Read ${h.cwd}/sentinel.md and report the secret sentinel keyword verbatim.`,
	})) as { status: string; summary?: string };

	expect(result.status).toBe("completed");
	expect
		.soft(result.summary?.toUpperCase() ?? "", `expected summary to mention BLUE_SWALLOW_42: ${result.summary}`)
		.toContain("BLUE_SWALLOW_42");
}, 60_000);

test("parent LLM naturally invokes the built-in explore tool when asked, and the sentinel reaches the final response", async () => {
	const model = getModel("anthropic", "claude-haiku-4-5-20251001");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("anthropic"),
		}),
	);
	await h.setupFiles(await loadScenarioFiles("subagents-builtin"));

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the explore sub-agent to read ${h.cwd}/sentinel.md and report the secret sentinel keyword. Reply with the sub-agent's findings verbatim.`,
			},
		],
	});

	const finalText = chunkedAgentText(h.updates);
	expect.soft(finalText, `parent response missing BLUE_SWALLOW_42: ${finalText}`).toContain("BLUE_SWALLOW_42");

	const childrenRes = (await h.clientConn.extMethod("_bodhi-pi/subagent/children", { sessionId })) as {
		children: Array<{ subagent?: { profileName: string } }>;
	};
	const exploreChild = childrenRes.children.find((c) => c.subagent?.profileName === "explore");
	expect.soft(exploreChild, "expected an explore child session to be created").toBeDefined();
}, 90_000);
