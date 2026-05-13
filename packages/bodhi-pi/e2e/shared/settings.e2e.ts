import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";

// Pure-extMethod coverage for `_bodhi-pi/session/settings/{get,set,unset,list}`.
// No LLM calls — flow exercises the three-tier scope hierarchy
// (global / project / session) and dotted-key paths against the agent's settings
// machinery. A throwaway openai model is passed because the harness still
// requires `models` + `defaultModelId`; we never call `prompt()`.

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

const SETTINGS_SET = "_bodhi-pi/session/settings/set";
const SETTINGS_GET = "_bodhi-pi/session/settings/get";
const SETTINGS_UNSET = "_bodhi-pi/session/settings/unset";
const SETTINGS_LIST = "_bodhi-pi/session/settings/list";

test("settings: three-tier hierarchy (project / session / default) + dotted-key paths + source resolution", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => "ignored-no-prompts",
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	// Step 1: project scope starts empty.
	let r = await h.clientConn.extMethod(SETTINGS_LIST, { sessionId, scope: "project" });
	expect.soft(r.scope).toBe("project");
	expect.soft(r.settings).toEqual({});

	// Step 2: write `appendSystemPrompt` at the project scope.
	r = await h.clientConn.extMethod(SETTINGS_SET, {
		sessionId,
		scope: "project",
		key: "appendSystemPrompt",
		value: "from-project",
	});
	expect.soft(r.key).toBe("appendSystemPrompt");
	expect.soft(r.scope).toBe("project");
	expect.soft(r.effective).toBe("from-project");

	// Step 3: project list reflects the write.
	r = await h.clientConn.extMethod(SETTINGS_LIST, { sessionId, scope: "project" });
	expect.soft((r.settings as Record<string, unknown>).appendSystemPrompt).toBe("from-project");

	// Step 4: a get with default (session) scope shows value=null at the session tier,
	// effective resolves through project, source identifies "project".
	r = await h.clientConn.extMethod(SETTINGS_GET, { sessionId, key: "appendSystemPrompt" });
	expect.soft(r.scope).toBe("session");
	expect.soft(r.value).toBeNull();
	expect.soft(r.effective).toBe("from-project");
	expect.soft(r.source).toBe("project");

	// Step 5–6: session-scope overrides only persist when the agent is stateful
	// across calls. bodhi-pi-http rebuilds the agent per turn, so session
	// overrides reset before the next read — skip session-tier assertions under
	// http and verify only that the write itself returns the expected effective.
	if (!isRuntime("http")) {
		r = await h.clientConn.extMethod(SETTINGS_SET, {
			sessionId,
			scope: "session",
			key: "appendSystemPrompt",
			value: "from-session",
		});
		expect.soft(r.effective).toBe("from-session");
		r = await h.clientConn.extMethod(SETTINGS_GET, { sessionId, key: "appendSystemPrompt" });
		expect.soft(r.value).toBe("from-session");
		expect.soft(r.effective).toBe("from-session");
		expect.soft(r.source).toBe("session");

		r = await h.clientConn.extMethod(SETTINGS_UNSET, {
			sessionId,
			scope: "session",
			key: "appendSystemPrompt",
		});
		expect.soft(r.effective).toBe("from-project");
	}

	// Step 7: dotted-key path — set `compaction.enabled` at project scope, read it back.
	r = await h.clientConn.extMethod(SETTINGS_SET, {
		sessionId,
		scope: "project",
		key: "compaction.enabled",
		value: false,
	});
	expect.soft(r.effective).toBe(false);
	r = await h.clientConn.extMethod(SETTINGS_LIST, { sessionId, scope: "project" });
	const projSettings = r.settings as { compaction?: { enabled?: boolean } };
	expect.soft(projSettings.compaction?.enabled).toBe(false);
	r = await h.clientConn.extMethod(SETTINGS_GET, {
		sessionId,
		scope: "project",
		key: "compaction.enabled",
	});
	expect.soft(r.value).toBe(false);
	expect.soft(r.source).toBe("project");

	// Step 8: unset project — effective falls back to the built-in default; source is "default".
	r = await h.clientConn.extMethod(SETTINGS_UNSET, {
		sessionId,
		scope: "project",
		key: "appendSystemPrompt",
	});
	r = await h.clientConn.extMethod(SETTINGS_GET, { sessionId, key: "appendSystemPrompt" });
	expect.soft(r.effective).toBeNull();
	expect.soft(r.source).toBe("default");
});
