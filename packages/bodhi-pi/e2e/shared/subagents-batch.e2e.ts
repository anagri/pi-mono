import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { loadScenarioFiles } from "../helpers/load-scenario.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

test("subagent_batch: parent LLM dispatches three counters in parallel; aggregated results reach the final reply", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);
	await h.setupFiles(await loadScenarioFiles("subagents-batch"));

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the subagent_batch tool in a single tool call to dispatch the word-count, line-count, and char-count sub-agents in parallel against ${h.cwd}/sample.txt. Then reply with one line per sub-agent's verbatim output.`,
			},
		],
	});

	const finalText = chunkedAgentText(h.updates);
	expect.soft(finalText, `parent reply missing word-count: ${finalText}`).toMatch(/word-count\s*:\s*\d+/i);
	expect.soft(finalText, `parent reply missing line-count: ${finalText}`).toMatch(/line-count\s*:\s*\d+/i);
	expect.soft(finalText, `parent reply missing char-count: ${finalText}`).toMatch(/char-count\s*:\s*\d+/i);

	const childrenRes = (await h.clientConn.extMethod("_bodhi-pi/subagent/children", { sessionId })) as {
		children: Array<{ sessionId: string; subagent?: { profileName: string } }>;
	};
	const childProfiles = childrenRes.children.map((c) => c.subagent?.profileName ?? "?").sort();
	expect
		.soft(childProfiles, `expected three batched children, got ${JSON.stringify(childProfiles)}`)
		.toEqual(["char-count", "line-count", "word-count"]);
}, 120_000); // batch with 3 children + LLM round-trips comfortably exceeds 30s
