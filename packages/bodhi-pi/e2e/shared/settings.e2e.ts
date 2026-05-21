import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

// Pure-extMethod coverage for `client.settings.{get,set,unset,list}`. No LLM
// calls — flow exercises the three-tier scope hierarchy (global / project /
// session) and dotted-key paths against the agent's settings machinery. A
// throwaway openai model is passed because the harness still requires
// `models` + `defaultModelId`; we never call `prompt()`.

const harness = useHarness();

test("settings: three-tier hierarchy (project / session / default) + dotted-key paths + source resolution", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => "ignored-no-prompts",
		}),
	);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	// Step 1: project scope starts empty.
	let list = await h.client.settings.list({ sessionId, scope: "project" });
	expect.soft(list.scope).toBe("project");
	expect.soft(list.settings).toEqual({});

	// Step 2: write `appendSystemPrompt` at the project scope.
	const setProject = await h.client.settings.set({
		sessionId,
		scope: "project",
		key: "appendSystemPrompt",
		value: "from-project",
	});
	expect.soft(setProject.key).toBe("appendSystemPrompt");
	expect.soft(setProject.scope).toBe("project");
	expect.soft(setProject.effective).toBe("from-project");

	// Step 3: project list reflects the write.
	list = await h.client.settings.list({ sessionId, scope: "project" });
	expect.soft((list.settings as Record<string, unknown>).appendSystemPrompt).toBe("from-project");

	// Step 4: a get with default (session) scope shows value=null at the session tier,
	// effective resolves through project, source identifies "project".
	const getDefault = await h.client.settings.get({ sessionId, key: "appendSystemPrompt" });
	expect.soft(getDefault.scope).toBe("session");
	expect.soft(getDefault.value).toBeNull();
	expect.soft(getDefault.effective).toBe("from-project");
	expect.soft(getDefault.source).toBe("project");

	const setSession = await h.client.settings.set({
		sessionId,
		scope: "session",
		key: "appendSystemPrompt",
		value: "from-session",
	});
	expect.soft(setSession.effective).toBe("from-session");
	const getSession = await h.client.settings.get({ sessionId, key: "appendSystemPrompt" });
	expect.soft(getSession.value).toBe("from-session");
	expect.soft(getSession.effective).toBe("from-session");
	expect.soft(getSession.source).toBe("session");

	const unsetSession = await h.client.settings.unset({
		sessionId,
		scope: "session",
		key: "appendSystemPrompt",
	});
	expect.soft(unsetSession.effective).toBe("from-project");

	// Step 7: dotted-key path — set `compaction.enabled` at project scope, read it back.
	const setDotted = await h.client.settings.set({
		sessionId,
		scope: "project",
		key: "compaction.enabled",
		value: false,
	});
	expect.soft(setDotted.effective).toBe(false);
	list = await h.client.settings.list({ sessionId, scope: "project" });
	const projSettings = list.settings as { compaction?: { enabled?: boolean } };
	expect.soft(projSettings.compaction?.enabled).toBe(false);
	const getDotted = await h.client.settings.get({
		sessionId,
		scope: "project",
		key: "compaction.enabled",
	});
	expect.soft(getDotted.value).toBe(false);
	expect.soft(getDotted.source).toBe("project");

	// Step 8: unset project — effective falls back to the built-in default; source is "default".
	await h.client.settings.unset({
		sessionId,
		scope: "project",
		key: "appendSystemPrompt",
	});
	const getAfter = await h.client.settings.get({ sessionId, key: "appendSystemPrompt" });
	expect.soft(getAfter.effective).toBeNull();
	expect.soft(getAfter.source).toBe("default");
});
