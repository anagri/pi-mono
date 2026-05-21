import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { loadScenarioFiles } from "../helpers/load-scenario.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

test("subagent: parent LLM invokes the extractor profile and surfaces the summary", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);

	await h.setupFiles(await loadScenarioFiles("subagents-extractor"));

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the extractor sub-agent to summarize the file at ${h.cwd}/doc.md. Reply with the sub-agent's summary verbatim.`,
			},
		],
	});

	const finalText = chunkedAgentText(h.updates).toLowerCase();
	expect.soft(finalText, `parent response missing "fox": ${finalText}`).toContain("fox");

	const childrenRes = (await h.clientConn.extMethod("_bodhi-pi/subagent/children", { sessionId })) as {
		children: Array<{ sessionId: string; subagent?: { profileName: string } }>;
	};
	expect.soft(childrenRes.children.length, "expected one child session").toBeGreaterThanOrEqual(1);
	const child = childrenRes.children.find((c) => c.subagent?.profileName === "extractor");
	expect.soft(child, "extractor child not found in /children").toBeDefined();

	const defaultList = await h.clientConn.listSessions({ cwd: h.cwd });
	const defaultIds = defaultList.sessions.map((s) => s.sessionId);
	expect.soft(defaultIds).toContain(sessionId);
	if (child) expect.soft(defaultIds, "child must NOT appear in default list").not.toContain(child.sessionId);
}, 60_000);
