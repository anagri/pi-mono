import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { loadScenarioFiles } from "../helpers/load-scenario.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

interface ListedProfile {
	name: string;
	description: string;
	tools?: string[];
	context: string;
	maxTurns: number;
	source: "project" | "extension" | "builtin";
}

test("/agents extMethod returns project profiles merged with built-ins, tagged by source", async () => {
	const model = getModel("anthropic", "claude-haiku-4-5-20251001");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("anthropic"),
		}),
	);

	await h.setupFiles(await loadScenarioFiles("subagents-list-profiles"));

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const res = (await h.clientConn.extMethod("_bodhi-pi/subagent/list", { sessionId })) as {
		profiles: ListedProfile[];
	};

	const byName = Object.fromEntries(res.profiles.map((p) => [p.name, p]));
	expect(Object.keys(byName).sort()).toEqual(["explore", "extractor", "planner"]);
	expect(byName.extractor.source).toBe("project");
	expect(byName.planner.source).toBe("project");
	expect(byName.explore.source).toBe("builtin");
	expect(byName.extractor.description).toBe("Read a file and return a one-sentence summary.");
});

test("/agents extMethod returns only built-ins when no .bodhi-pi/agents/ directory", async () => {
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
	for (const p of res.profiles) expect(p.source).toBe("builtin");
});
