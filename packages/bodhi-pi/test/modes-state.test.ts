import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { type Api, fauxAssistantMessage, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	createBodhiPiAgent,
	createInMemoryFilesystem,
	createInMemorySessionStore,
	type ModeChangeEntry,
} from "@/index.js";
import { MODE_CONFIG_ID, MODEL_CONFIG_ID } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

let registrations: Array<{ unregister: () => void }> = [];

beforeEach(() => {
	registrations = [];
});
afterEach(() => {
	for (const r of registrations) r.unregister();
	registrations = [];
});

function fauxModel(modelId = "faux-mode-model"): Model<Api> {
	const faux = registerFauxProvider({ models: [{ id: modelId }] });
	registrations.push(faux);
	faux.setResponses([() => fauxAssistantMessage("ok"), () => fauxAssistantMessage("ok2")]);
	return faux.getModel() as Model<Api>;
}

function findOption(options: readonly SessionConfigOption[] | undefined, id: string): SessionConfigOption | undefined {
	return options?.find((o) => o.id === id);
}

function currentValueOf(option: SessionConfigOption | undefined): unknown {
	return option && "currentValue" in option ? option.currentValue : undefined;
}

test("default new session boots with mode = 'ask'", async () => {
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const res = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const mode = findOption(res.configOptions, MODE_CONFIG_ID);
	expect(currentValueOf(mode)).toBe("ask");
});

test("configOptions advertises mode FIRST with category 'mode'", async () => {
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const res = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const ids = (res.configOptions ?? []).map((o: SessionConfigOption) => o.id);
	expect(ids[0]).toBe(MODE_CONFIG_ID);
	expect(ids).toContain(MODEL_CONFIG_ID);
	const mode = findOption(res.configOptions, MODE_CONFIG_ID);
	expect(mode?.category).toBe("mode");
});

test("setSessionConfigOption mode='edit' mutates mode and returns full configOptions", async () => {
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const res = await harness.clientConn.setSessionConfigOption({
		sessionId,
		configId: MODE_CONFIG_ID,
		value: "edit",
	});
	expect(currentValueOf(findOption(res.configOptions, MODE_CONFIG_ID))).toBe("edit");
	expect(findOption(res.configOptions, MODEL_CONFIG_ID)).toBeDefined();
});

test("config_option_update notification fires after setSessionConfigOption", async () => {
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const beforeCount = harness.updates.filter((u) => u.update.sessionUpdate === "config_option_update").length;
	await harness.clientConn.setSessionConfigOption({
		sessionId,
		configId: MODE_CONFIG_ID,
		value: "plan",
	});
	const updates = harness.updates.filter((u) => u.update.sessionUpdate === "config_option_update");
	expect(updates.length).toBeGreaterThan(beforeCount);
	const last = updates[updates.length - 1];
	const optionsInUpdate = last.update.sessionUpdate === "config_option_update" ? last.update.configOptions : undefined;
	expect(currentValueOf(findOption(optionsInUpdate, MODE_CONFIG_ID))).toBe("plan");
});

test("mode persists across closeSession + loadSession via mode_change entry", async () => {
	const sessionStore = createInMemorySessionStore();
	const filesystem = createInMemoryFilesystem();
	const model = fauxModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		sessionStore,
		filesystem,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.setSessionConfigOption({ sessionId, configId: MODE_CONFIG_ID, value: "edit" });
	await harness.clientConn.closeSession({ sessionId });

	const res = await harness.clientConn.loadSession({ sessionId, cwd: "/proj", mcpServers: [] });
	expect(currentValueOf(findOption(res.configOptions, MODE_CONFIG_ID))).toBe("edit");
});

test("rejects mode='allow-all' with -32603 when allowsAllowAllMode is false", async () => {
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await expect(
		harness.clientConn.setSessionConfigOption({ sessionId, configId: MODE_CONFIG_ID, value: "allow-all" }),
	).rejects.toThrow(/allow-all/);
});

test("accepts mode='allow-all' when allowsAllowAllMode is true", async () => {
	const model = fauxModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		allowsAllowAllMode: true,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const res = await harness.clientConn.setSessionConfigOption({
		sessionId,
		configId: MODE_CONFIG_ID,
		value: "allow-all",
	});
	expect(currentValueOf(findOption(res.configOptions, MODE_CONFIG_ID))).toBe("allow-all");
});

test("omits allow-all option from advertised list when allowsAllowAllMode is false", async () => {
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const res = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const mode = findOption(res.configOptions, MODE_CONFIG_ID);
	const values = mode && "options" in mode ? (mode.options as Array<{ value: string }>).map((o) => o.value) : [];
	expect(values).toEqual(["ask", "plan", "edit"]);
});

test("includes allow-all option when allowsAllowAllMode is true", async () => {
	const model = fauxModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		allowsAllowAllMode: true,
	});
	await harness.clientConn.initialize(stdInitParams);
	const res = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const mode = findOption(res.configOptions, MODE_CONFIG_ID);
	const values = mode && "options" in mode ? (mode.options as Array<{ value: string }>).map((o) => o.value) : [];
	expect(values).toEqual(["ask", "plan", "edit", "allow-all"]);
});

test("BodhiPiConfig.defaultMode wins over the 'ask' fallback", async () => {
	const model = fauxModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		defaultMode: "plan",
	});
	await harness.clientConn.initialize(stdInitParams);
	const res = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	expect(currentValueOf(findOption(res.configOptions, MODE_CONFIG_ID))).toBe("plan");
});

test("factory throws when defaultMode='allow-all' without allowsAllowAllMode capability", () => {
	const model = fauxModel();
	expect(() =>
		createBodhiPiAgent({
			models: [model],
			defaultModelId: model.id,
			sessionStore: createInMemorySessionStore(),
			filesystem: createInMemoryFilesystem(),
			defaultMode: "allow-all",
		}),
	).toThrow(/allowsAllowAllMode/);
});

test("factory throws when defaultMode='allow-all' has allowsAllowAllMode but not allowsAllowAllModeAsDefault", () => {
	const model = fauxModel();
	expect(() =>
		createBodhiPiAgent({
			models: [model],
			defaultModelId: model.id,
			sessionStore: createInMemorySessionStore(),
			filesystem: createInMemoryFilesystem(),
			defaultMode: "allow-all",
			allowsAllowAllMode: true,
		}),
	).toThrow(/allowsAllowAllModeAsDefault/);
});

test("settings.defaultMode='allow-all' logs error and falls through when allowsAllowAllModeAsDefault is false", async () => {
	const model = fauxModel();
	const errors: string[] = [];
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		allowsAllowAllMode: true,
		logger: { error: (msg) => errors.push(msg), warn: () => {} },
	});
	await harness.clientConn.initialize(stdInitParams);
	await harness.filesystem.mkdir("/proj/.bodhi-pi", { recursive: true });
	await harness.filesystem.writeTextFile(
		"/proj/.bodhi-pi/settings.json",
		JSON.stringify({ defaultMode: "allow-all" }),
	);
	const res = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	expect(currentValueOf(findOption(res.configOptions, MODE_CONFIG_ID))).toBe("ask");
	expect(errors.some((m) => m.includes("allow-all"))).toBe(true);
});

test("settings.defaultMode with unknown value logs warning and falls through", async () => {
	const model = fauxModel();
	const warnings: string[] = [];
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		logger: { error: () => {}, warn: (msg) => warnings.push(msg) },
	});
	await harness.clientConn.initialize(stdInitParams);
	await harness.filesystem.mkdir("/proj/.bodhi-pi", { recursive: true });
	await harness.filesystem.writeTextFile("/proj/.bodhi-pi/settings.json", JSON.stringify({ defaultMode: "bogus" }));
	const res = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	expect(currentValueOf(findOption(res.configOptions, MODE_CONFIG_ID))).toBe("ask");
	expect(warnings.some((m) => m.includes("bogus"))).toBe(true);
});

test("setMode with current mode still appends an entry (non-idempotent)", async () => {
	const sessionStore = createInMemorySessionStore();
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, sessionStore });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.setSessionConfigOption({ sessionId, configId: MODE_CONFIG_ID, value: "ask" });
	await harness.clientConn.setSessionConfigOption({ sessionId, configId: MODE_CONFIG_ID, value: "ask" });
	const record = await sessionStore.load(sessionId);
	const modeEntries = (record?.entries ?? []).filter((e): e is ModeChangeEntry => e.type === "mode_change");
	expect(modeEntries.length).toBe(2);
});

test("mode_change entries do NOT leak into LLM message context", async () => {
	const sessionStore = createInMemorySessionStore();
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, sessionStore });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.setSessionConfigOption({ sessionId, configId: MODE_CONFIG_ID, value: "edit" });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });
	const record = await sessionStore.load(sessionId);
	const messageEntries = (record?.entries ?? []).filter((e) => e.type === "message");
	const modeEntries = (record?.entries ?? []).filter((e) => e.type === "mode_change");
	expect(modeEntries.length).toBeGreaterThan(0);
	const userMessages = messageEntries.filter((e) => e.type === "message" && e.message.role === "user");
	expect(userMessages.length).toBe(1);
});

test("unknown configId is rejected with -32602", async () => {
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await expect(
		harness.clientConn.setSessionConfigOption({ sessionId, configId: "bogus", value: "x" }),
	).rejects.toThrow(/unknown configId/);
});

test("invalid mode value is rejected with -32602", async () => {
	const model = fauxModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await expect(
		harness.clientConn.setSessionConfigOption({ sessionId, configId: MODE_CONFIG_ID, value: "bogus" }),
	).rejects.toThrow(/mode config requires/);
});
