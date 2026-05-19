import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AUTH_PREFIX } from "@/index.js";
import {
	EXT_KV_REMOVE,
	EXT_KV_SET,
	EXT_SESSION_CLONE,
	EXT_SESSION_FORK,
	EXT_SESSION_NAVIGATE,
	EXT_SESSION_SET_NAME,
	EXT_SESSION_SETTINGS_SET,
	EXT_SESSION_SETTINGS_UNSET,
	EXT_SESSION_TREE,
} from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { findEventOfType, findUpdateOfKind } from "./helpers/acp-narrow.js";
import { recorder } from "./helpers/event-recorder.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];
beforeEach(() => {
	providers = [];
});
afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newFaux(): Model<Api> {
	const faux = registerFauxProvider();
	providers.push(faux);
	faux.setResponses([() => fauxAssistantMessage("ok")]);
	return faux.getModel() as Model<Api>;
}

test("auth_change fires for kv/set and kv/remove on auth/* keys", async () => {
	const model = newFaux();
	const rec = recorder();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		eventHandlers: rec.handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_KV_SET, {
		sessionId,
		key: `${AUTH_PREFIX}${model.provider}`,
		value: "sk-XYZ",
		secret: true,
	});
	const loginEvents = rec.log.filter((e) => e.type === "auth_change");
	expect(loginEvents.length, "one auth_change after kv/set").toBe(1);
	const login = findEventOfType(rec.log, "auth_change");
	expect(login.action).toBe("login");
	expect(login.provider).toBe(model.provider);
	expect(login.sessionId).toBe(sessionId);

	rec.log.length = 0;
	await harness.clientConn.extMethod(EXT_KV_REMOVE, {
		sessionId,
		key: `${AUTH_PREFIX}${model.provider}`,
	});
	const logout = findEventOfType(rec.log, "auth_change");
	expect(logout.action).toBe("logout");
	expect(logout.provider).toBe(model.provider);
});

test("auth_change fires with sessionId=undefined for off-session writes", async () => {
	const model = newFaux();
	const rec = recorder();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		eventHandlers: rec.handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_KV_SET, {
		key: `${AUTH_PREFIX}other`,
		value: "k",
		secret: true,
	});
	const ev = findEventOfType(rec.log, "auth_change");
	expect(ev.sessionId).toBeUndefined();
	expect(ev.provider).toBe("other");
});

test("settings_change fires for set and unset", async () => {
	const model = newFaux();
	const rec = recorder();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		eventHandlers: rec.handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "appendSystemPrompt",
		value: "hello",
		scope: "session",
	});
	const setEvent = findEventOfType(rec.log, "settings_change");
	expect(setEvent.reason).toBe("set");
	expect(setEvent.scope).toBe("session");
	expect(setEvent.key).toBe("appendSystemPrompt");
	expect(setEvent.value).toBe("hello");

	rec.log.length = 0;
	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_UNSET, {
		sessionId,
		key: "appendSystemPrompt",
		scope: "session",
	});
	const unsetEvent = findEventOfType(rec.log, "settings_change");
	expect(unsetEvent.reason).toBe("unset");
	expect(unsetEvent.value).toBeNull();
});

test("session_navigate fires when navigating backward (cross-branch by definition)", async () => {
	const model = newFaux();
	const rec = recorder();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		eventHandlers: rec.handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	const tree = (await harness.clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: Array<{ id: string; type: string; role?: string }>;
	};
	const userMsg = tree.nodes.find((n) => n.type === "message" && n.role === "user");
	expect(userMsg, "user message present in tree").toBeDefined();

	rec.log.length = 0;
	await harness.clientConn.extMethod(EXT_SESSION_NAVIGATE, {
		sessionId,
		targetEntryId: (userMsg as { id: string }).id,
	});
	const navEvent = findEventOfType(rec.log, "session_navigate");
	expect(navEvent.toLeafId).toBe((userMsg as { id: string }).id);
	// Navigating to an ancestor leaf is "cross-branch" per detectCrossBranch's definition
	// (target's parentId chain does not include the old leaf).
	expect(navEvent.crossedBranches).toBe(true);
});

test("session_fork fires after fork", async () => {
	const model = newFaux();
	const rec = recorder();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		eventHandlers: rec.handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	const tree = (await harness.clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: Array<{ id: string; type: string; role?: string }>;
	};
	const userMsg = tree.nodes.find((n) => n.type === "message" && n.role === "user");
	expect(userMsg, "user message present").toBeDefined();

	rec.log.length = 0;
	const result = (await harness.clientConn.extMethod(EXT_SESSION_FORK, {
		sessionId,
		entryId: (userMsg as { id: string }).id,
		position: "before",
	})) as { newSessionId: string };
	const forkEvent = findEventOfType(rec.log, "session_fork");
	expect(forkEvent.newSessionId).toBe(result.newSessionId);
	expect(forkEvent.fromEntryId).toBe((userMsg as { id: string }).id);
	expect(forkEvent.position).toBe("before");
});

test("session_clone fires after clone", async () => {
	const model = newFaux();
	const rec = recorder();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		eventHandlers: rec.handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	rec.log.length = 0;
	const result = (await harness.clientConn.extMethod(EXT_SESSION_CLONE, { sessionId })) as { newSessionId: string };
	const cloneEvent = findEventOfType(rec.log, "session_clone");
	expect(cloneEvent.newSessionId).toBe(result.newSessionId);
});

test("session_info_update sessionUpdate fires after setName", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	harness.updates.length = 0;

	await harness.clientConn.extMethod(EXT_SESSION_SET_NAME, { sessionId, name: "my session" });

	const update = findUpdateOfKind(harness.updates, "session_info_update", sessionId);
	expect(update.title).toBe("my session");
	expect(update.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("setSessionConfigOption emits config_option_update notification (model_select subscriber)", async () => {
	const m1 = newFaux();
	const m2 = newFaux();
	const harness = createTestHarness({ models: [m1, m2], defaultModelId: m1.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	harness.updates.length = 0;

	await harness.clientConn.setSessionConfigOption({ sessionId, configId: "model", value: m2.id });

	const update = findUpdateOfKind(harness.updates, "config_option_update", sessionId);
	const modelOpt = update.configOptions.find((o) => o.id === "model");
	expect(modelOpt?.currentValue).toBe(m2.id);
});
