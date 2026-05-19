import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { loadScenarioFiles } from "../helpers/load-scenario.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

test("parallel subagent calls: parent LLM dispatches three counters via separate subagent tool calls in one assistant turn; aggregated results reach the final reply", async () => {
	const model = getModel("openai", "gpt-5-mini");
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
				text: `Dispatch the word-count, line-count, and char-count sub-agents against ${h.cwd}/sample.txt in parallel by issuing three separate \`subagent\` tool calls in the same assistant turn (one tool call per counter). Do not call any tool named subagent_batch — it does not exist. After all three return, summarise each sub-agent's count in your final reply.`,
			},
		],
	});

	const childrenRes = (await h.clientConn.extMethod("_bodhi-pi/subagent/children", { sessionId })) as {
		children: Array<{ sessionId: string; subagent?: { profileName: string } }>;
	};
	const childProfiles = childrenRes.children.map((c) => c.subagent?.profileName ?? "?").sort();
	expect(childProfiles, `expected three parallel children, got ${JSON.stringify(childProfiles)}`).toEqual([
		"char-count",
		"line-count",
		"word-count",
	]);

	const finalText = chunkedAgentText(h.updates).toLowerCase();
	expect.soft(finalText, `parent reply missing word count: ${finalText}`).toMatch(/word.{0,25}\d+/);
	expect.soft(finalText, `parent reply missing line count: ${finalText}`).toMatch(/line.{0,25}\d+/);
	expect.soft(finalText, `parent reply missing char count: ${finalText}`).toMatch(/char.{0,25}\d+/);
}, 120_000);
