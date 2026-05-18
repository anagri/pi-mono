import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { loadScenarioFiles } from "../helpers/load-scenario.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

test("/agents extMethod returns discovered profiles from `.bodhi-pi/agents/`", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);

	await h.setupFiles(await loadScenarioFiles("subagents-list-profiles"));

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const res = (await h.clientConn.extMethod("_bodhi-pi/subagent/list", { sessionId })) as {
		profiles: Array<{ name: string; description: string; tools?: string[]; context: string; maxTurns: number }>;
	};

	expect(res.profiles).toEqual([
		{
			name: "extractor",
			description: "Read a file and return a one-sentence summary.",
			context: "fresh",
			tools: ["read"],
			maxTurns: 50,
		},
		{
			name: "planner",
			description: "Make a short implementation plan from a task description.",
			context: "fresh",
			maxTurns: 50,
		},
	]);
});

test("/agents extMethod returns [] when no .bodhi-pi/agents/ directory", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const res = (await h.clientConn.extMethod("_bodhi-pi/subagent/list", { sessionId })) as { profiles: unknown[] };

	expect(res.profiles).toEqual([]);
});
