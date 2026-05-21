import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { createE2EHarness } from "../helpers/harness.js";
import { loadScenarioFiles } from "../helpers/load-scenario.js";
import { subagentApiKey, subagentModel } from "../helpers/models.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

test("subagent fork: parent reads a diff, spawns the reviewer fork sub-agent, child surfaces the sentinel from inherited transcript", async () => {
	const model = subagentModel();
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: subagentApiKey,
		}),
	);

	await h.setupFiles(await loadScenarioFiles("subagents-fork"));

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.setSessionConfigOption({ sessionId, configId: "model", value: model.id });
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text:
					`Step 1: use the read tool on ${h.cwd}/diff.md to load the diff. ` +
					`Step 2: use the reviewer sub-agent (it forks your context, so do NOT include the diff text in the task body) to identify the new symbol name introduced by the rename. ` +
					`Reply with the reviewer's findings verbatim.`,
			},
		],
	});

	const finalText = chunkedAgentText(h.updates);
	expect
		.soft(finalText, `parent response missing BLUE_FORK_42_handler: ${finalText}`)
		.toContain("BLUE_FORK_42_handler");

	const childrenRes = (await h.clientConn.extMethod("_bodhi-pi/subagent/children", { sessionId })) as {
		children: Array<{ sessionId: string; subagent?: { profileName: string } }>;
	};
	const reviewerChild = childrenRes.children.find((c) => c.subagent?.profileName === "reviewer");
	expect.soft(reviewerChild, "reviewer child not found in /children").toBeDefined();
}, 90_000);
