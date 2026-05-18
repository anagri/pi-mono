import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

// C1 e2e: the `_bodhi-pi/subagent/list` extMethod returns discovered profiles
// across every runtime. No LLM call — only the discovery + extMethod path is
// exercised. Real-LLM e2e for the spawn flow lands in C2's subagents.e2e.ts.

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

	await h.setupFiles({
		".bodhi-pi/agents/extractor.md":
			"---\ndescription: Read a file and return a one-sentence summary.\ntools:\n  - read\n---\nYou are an extractor sub-agent. Summarize the file at the given path in one sentence.\n",
		".bodhi-pi/agents/planner.md":
			"---\ndescription: Make a short implementation plan from a task description.\n---\nYou are a planner sub-agent. Produce a short bulleted plan.\n",
	});

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
