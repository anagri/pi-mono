import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import {
	EXT_SESSION_SETTINGS_GET,
	EXT_SESSION_SETTINGS_LIST,
	EXT_SESSION_SETTINGS_SET,
	EXT_SESSION_SETTINGS_UNSET,
} from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { findUpdateOfKind, hasUpdateOfKind } from "./helpers/acp-narrow.js";
import { seedGlobalSettings } from "./helpers/filesystem.js";
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

test("set --session mutates only in-memory overrides (no FS writes)", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "appendSystemPrompt",
		value: "EXTRA",
		scope: "session",
	});

	expect(await filesystem.exists("/proj/.bodhi-pi/settings.json")).toBe(false);
	const result = (await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_LIST, {
		sessionId,
		scope: "session",
	})) as { scope: string; settings: { appendSystemPrompt?: string } };
	expect(result.scope).toBe("session");
	expect(result.settings.appendSystemPrompt).toBe("EXTRA");
});

test("set --project writes .bodhi-pi/settings.json", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "compaction.reserveTokens",
		value: 7777,
		scope: "project",
	});

	const written = await filesystem.readTextFile("/proj/.bodhi-pi/settings.json");
	expect(JSON.parse(written)).toEqual({ compaction: { reserveTokens: 7777 } });
});

test("set --global writes ~/.bodhi-pi/settings.json when homeDir set", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		homeDir: "/home/user",
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "defaultThinkingLevel",
		value: "high",
		scope: "global",
	});

	const written = await filesystem.readTextFile("/home/user/.bodhi-pi/settings.json");
	expect(JSON.parse(written)).toEqual({ defaultThinkingLevel: "high" });
});

test("set --global errors with -32602 when homeDir is unset", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await expect(
		harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
			sessionId,
			key: "foo",
			value: "bar",
			scope: "global",
		}),
	).rejects.toThrow(/--global scope not supported on this runtime/);
});

test("unset --session removes the override; effective falls back to next layer", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	await seedGlobalSettings(filesystem, "/home/user", JSON.stringify({ appendSystemPrompt: "FROM-GLOBAL" }));
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		homeDir: "/home/user",
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "appendSystemPrompt",
		value: "OVERRIDE",
		scope: "session",
	});
	const get1 = (await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_GET, {
		sessionId,
		key: "appendSystemPrompt",
	})) as { effective: string; source: string };
	expect(get1.effective).toBe("OVERRIDE");
	expect(get1.source).toBe("session");

	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_UNSET, {
		sessionId,
		key: "appendSystemPrompt",
		scope: "session",
	});
	const get2 = (await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_GET, {
		sessionId,
		key: "appendSystemPrompt",
	})) as { effective: string; source: string };
	expect(get2.effective).toBe("FROM-GLOBAL");
	expect(get2.source).toBe("global");
});

test("list returns effective merged view by default", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	await seedGlobalSettings(filesystem, "/home/user", JSON.stringify({ defaultThinkingLevel: "low" }));
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		homeDir: "/home/user",
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_LIST, { sessionId })) as {
		scope: string;
		settings: { defaultThinkingLevel?: string };
	};
	expect(result.scope).toBe("effective");
	expect(result.settings.defaultThinkingLevel).toBe("low");
});

test("dotted keys parse into nested objects", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "providerOptions.openai.maxRetryDelayMs",
		value: 5000,
		scope: "project",
	});
	const written = JSON.parse(await filesystem.readTextFile("/proj/.bodhi-pi/settings.json"));
	expect(written).toEqual({ providerOptions: { openai: { maxRetryDelayMs: 5000 } } });
});

test("string values JSON.parse when possible; fall back to raw string", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	// Numeric string parses as number.
	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "compaction.reserveTokens",
		value: "4242",
		scope: "project",
	});
	const written = JSON.parse(await filesystem.readTextFile("/proj/.bodhi-pi/settings.json"));
	expect(written.compaction.reserveTokens).toBe(4242);

	// Plain string stays a string.
	await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "appendSystemPrompt",
		value: "hello-world",
		scope: "project",
	});
	const written2 = JSON.parse(await filesystem.readTextFile("/proj/.bodhi-pi/settings.json"));
	expect(written2.appendSystemPrompt).toBe("hello-world");
});

test("settings/set defaultModel emits config_option_update sessionUpdate", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	harness.updates.length = 0;

	const result = (await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "defaultModel",
		value: model.id,
		scope: "project",
	})) as Record<string, unknown>;
	expect(result).not.toHaveProperty("configOptions");

	const update = findUpdateOfKind(harness.updates, "config_option_update", sessionId);
	expect(update.configOptions.some((o) => o.id === "model")).toBe(true);
});

test("settings/set non-picker key emits no config_option_update", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	harness.updates.length = 0;

	const result = (await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "appendSystemPrompt",
		value: "ignored",
		scope: "session",
	})) as Record<string, unknown>;
	expect(result).not.toHaveProperty("configOptions");
	expect(hasUpdateOfKind(harness.updates, "config_option_update")).toBe(false);
});
