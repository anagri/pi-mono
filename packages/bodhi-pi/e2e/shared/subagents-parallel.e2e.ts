import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import type { SubagentEndEvent, SubagentStartEvent } from "@/index.js";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { loadScenarioFiles } from "../helpers/load-scenario.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

test("parallel subagent calls: parent LLM dispatches three counters via separate subagent tool calls in one assistant turn; children run concurrently (serverTime overlap) and aggregated results reach the final reply", async () => {
	// Anthropic claude-haiku-4-5 is the model that reliably emits multiple tool
	// calls in one assistant turn — reasoning models like gpt-5-mini chunk
	// one-per-turn regardless of how strongly the prompt asks for parallel.
	const model = getModel("anthropic", "claude-haiku-4-5-20251001");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("anthropic"),
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
				text: `Dispatch the word-count, line-count, and char-count sub-agents against ${h.cwd}/sample.txt in parallel by issuing three separate \`subagent\` tool calls in the same assistant turn (one tool call per counter). After all three return, summarise each sub-agent's count in your final reply.`,
			},
		],
	});
	await h.flushEvents();

	const childrenRes = (await h.clientConn.extMethod("_bodhi-pi/subagent/children", { sessionId })) as {
		children: Array<{ sessionId: string; subagent?: { profileName: string } }>;
	};
	const childProfiles = childrenRes.children.map((c) => c.subagent?.profileName ?? "?").sort();
	expect
		.soft(childProfiles, `expected three parallel children, got ${JSON.stringify(childProfiles)}`)
		.toEqual(["char-count", "line-count", "word-count"]);

	const finalText = chunkedAgentText(h.updates).toLowerCase();
	const countToken = /(?:\d+|[a-z]+(?:[ -][a-z]+)?)/.source;
	expect
		.soft(finalText, `parent reply missing word count: ${finalText}`)
		.toMatch(new RegExp(`word.{0,25}${countToken}`));
	expect
		.soft(finalText, `parent reply missing line count: ${finalText}`)
		.toMatch(new RegExp(`line.{0,25}${countToken}`));
	expect
		.soft(finalText, `parent reply missing char count: ${finalText}`)
		.toMatch(new RegExp(`char.{0,25}${countToken}`));

	const starts = h.events.filter((e): e is SubagentStartEvent => e.type === "subagent_start");
	const ends = h.events.filter((e): e is SubagentEndEvent => e.type === "subagent_end");
	expect.soft(starts, "three subagent_start events").toHaveLength(3);
	expect.soft(ends, "three subagent_end events").toHaveLength(3);
	if (starts.length === 3 && ends.length === 3) {
		const startTimes = starts.map((e) => e.serverTime ?? 0);
		const endTimes = ends.map((e) => e.serverTime ?? 0);
		const maxStart = Math.max(...startTimes);
		const minEnd = Math.min(...endTimes);
		expect
			.soft(
				maxStart,
				`true parallelism: latest subagent_start (${maxStart}) must precede earliest subagent_end (${minEnd}). If start>end the model emitted tool calls one-per-turn instead of three-in-one-turn — known limitation of reasoning models like gpt-5-mini.`,
			)
			.toBeLessThanOrEqual(minEnd);
	}
}, 120_000);
