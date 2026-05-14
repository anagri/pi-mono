import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { loadProjectSettings } from "@/settings/settings.js";
import { loadGlobalSettings } from "@/settings/settings-global.js";
import { mergeSettings } from "@/settings/settings-merge.js";
import { EXT_SESSION_CONFIG, EXT_SESSION_SETTINGS_LIST } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedGlobalSettings, seedProjectSettings } from "./helpers/filesystem.js";
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

describe("loadProjectSettings", () => {
	test("missing file → empty result, present=false", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/proj", { recursive: true });
		const out = await loadProjectSettings(fs, "/proj");
		expect(out).toEqual({ settings: {}, present: false });
	});

	test("parses valid JSON", async () => {
		const fs = createInMemoryFilesystem();
		await seedProjectSettings(
			fs,
			"/proj",
			JSON.stringify({ compaction: { reserveTokens: 99999 }, appendSystemPrompt: "extra" }),
		);
		const out = await loadProjectSettings(fs, "/proj");
		expect(out.present).toBe(true);
		expect(out.settings.compaction).toEqual({ reserveTokens: 99999 });
		expect(out.settings.appendSystemPrompt).toBe("extra");
		expect(out.parseError).toBeUndefined();
	});

	test("malformed JSON → present=true, parseError set, empty settings", async () => {
		const fs = createInMemoryFilesystem();
		await seedProjectSettings(fs, "/proj", "{ not-json");
		const out = await loadProjectSettings(fs, "/proj");
		expect(out.present).toBe(true);
		expect(out.settings).toEqual({});
		expect(out.parseError).toMatch(/invalid JSON/);
	});

	test("JSON top-level not an object → parseError set", async () => {
		const fs = createInMemoryFilesystem();
		await seedProjectSettings(fs, "/proj", `["array"]`);
		const out = await loadProjectSettings(fs, "/proj");
		expect(out.present).toBe(true);
		expect(out.settings).toEqual({});
		expect(out.parseError).toMatch(/must be a JSON object/);
	});

	test("unknown keys preserved on returned settings", async () => {
		const fs = createInMemoryFilesystem();
		await seedProjectSettings(fs, "/proj", JSON.stringify({ futureFlag: 42 }));
		const out = await loadProjectSettings(fs, "/proj");
		expect(out.settings.futureFlag).toBe(42);
	});
});

describe("loadGlobalSettings", () => {
	test("missing file → empty, present=false", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/home/user", { recursive: true });
		const out = await loadGlobalSettings(fs, "/home/user");
		expect(out).toEqual({ settings: {}, present: false });
	});

	test("parses valid JSON", async () => {
		const fs = createInMemoryFilesystem();
		await seedGlobalSettings(fs, "/home/user", JSON.stringify({ defaultThinkingLevel: "medium" }));
		const out = await loadGlobalSettings(fs, "/home/user");
		expect(out.present).toBe(true);
		expect(out.settings.defaultThinkingLevel).toBe("medium");
		expect(out.parseError).toBeUndefined();
	});

	test("malformed JSON → parseError set, empty settings, never throws", async () => {
		const fs = createInMemoryFilesystem();
		await seedGlobalSettings(fs, "/home/user", "{ not-json");
		const out = await loadGlobalSettings(fs, "/home/user");
		expect(out.present).toBe(true);
		expect(out.settings).toEqual({});
		expect(out.parseError).toMatch(/invalid JSON/);
	});
});

describe("mergeSettings", () => {
	test("project overrides global for primitives", () => {
		const out = mergeSettings({ appendSystemPrompt: "G" }, { appendSystemPrompt: "P" });
		expect(out.appendSystemPrompt).toBe("P");
	});

	test("undefined override inherits from base", () => {
		const out = mergeSettings({ appendSystemPrompt: "G" }, { appendSystemPrompt: undefined });
		expect(out.appendSystemPrompt).toBe("G");
	});

	test("nested objects merge one level deep", () => {
		const out = mergeSettings(
			{ compaction: { reserveTokens: 1000, keepRecentTokens: 500 } },
			{ compaction: { reserveTokens: 9000 } },
		);
		expect(out.compaction).toEqual({ reserveTokens: 9000, keepRecentTokens: 500 });
	});

	test("providerOptions merges shallowly per-provider", () => {
		const out = mergeSettings(
			{ providerOptions: { openai: { maxRetries: 3 } } },
			{ providerOptions: { anthropic: { maxRetries: 5 } } },
		);
		expect(out.providerOptions).toEqual({
			openai: { maxRetries: 3 },
			anthropic: { maxRetries: 5 },
		});
	});
});

describe("layered settings (via session/config + settings/list)", () => {
	test("project overrides global, global inherits when project omits", async () => {
		const model = newFaux();
		const filesystem = createInMemoryFilesystem();
		await seedGlobalSettings(
			filesystem,
			"/home/user",
			JSON.stringify({
				compaction: { reserveTokens: 1000 },
				defaultThinkingLevel: "low",
				appendSystemPrompt: "FROM-GLOBAL",
			}),
		);
		await seedProjectSettings(filesystem, "/proj", JSON.stringify({ compaction: { reserveTokens: 4000 } }));
		const harness = createTestHarness({
			models: [model],
			defaultModelId: model.id,
			filesystem,
			homeDir: "/home/user",
		});
		await harness.clientConn.initialize(stdInitParams);
		const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

		// session/config still surfaces the resolved unique bits (compaction, appendSystemPrompt).
		const cfg = (await harness.clientConn.extMethod(EXT_SESSION_CONFIG, { sessionId })) as {
			compaction: { reserveTokens: number };
			appendSystemPrompt: string | null;
		};
		expect(cfg.compaction.reserveTokens).toBe(4000);
		expect(cfg.appendSystemPrompt).toBe("FROM-GLOBAL");

		// Per-scope layers move to settings/list.
		const effective = (await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_LIST, {
			sessionId,
			scope: "effective",
		})) as { scope: string; settings: { defaultThinkingLevel?: string } };
		expect(effective.scope).toBe("effective");
		expect(effective.settings.defaultThinkingLevel).toBe("low");

		const global = (await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_LIST, {
			sessionId,
			scope: "global",
		})) as { scope: string; settings: { appendSystemPrompt?: string } };
		expect(global.scope).toBe("global");
		expect(global.settings.appendSystemPrompt).toBe("FROM-GLOBAL");
	});

	test("homeDir omitted → settings/list?scope=global rejects (global scope unsupported)", async () => {
		const model = newFaux();
		const filesystem = createInMemoryFilesystem();
		await seedGlobalSettings(filesystem, "/home/user", JSON.stringify({ defaultThinkingLevel: "high" }));
		const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
		await harness.clientConn.initialize(stdInitParams);
		const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

		// When homeDir is unset the runtime refuses global-scope settings access.
		await expect(
			harness.clientConn.extMethod(EXT_SESSION_SETTINGS_LIST, { sessionId, scope: "global" }),
		).rejects.toThrow(/--global scope not supported on this runtime/);

		// The seeded /home/user file is therefore not visible in effective either.
		const effective = (await harness.clientConn.extMethod(EXT_SESSION_SETTINGS_LIST, {
			sessionId,
			scope: "effective",
		})) as { scope: string; settings: { defaultThinkingLevel?: string } };
		expect(effective.scope).toBe("effective");
		expect(effective.settings.defaultThinkingLevel).toBeUndefined();
	});

	test("parse error in global is non-fatal, surfaces via session/config", async () => {
		const model = newFaux();
		const filesystem = createInMemoryFilesystem();
		await seedGlobalSettings(filesystem, "/home/user", "{ not-json");
		const harness = createTestHarness({
			models: [model],
			defaultModelId: model.id,
			filesystem,
			homeDir: "/home/user",
		});
		await harness.clientConn.initialize(stdInitParams);
		const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

		const result = (await harness.clientConn.extMethod(EXT_SESSION_CONFIG, { sessionId })) as {
			globalSettingsParseError?: string;
		};
		expect(result.globalSettingsParseError).toMatch(/invalid JSON/);
	});
});
