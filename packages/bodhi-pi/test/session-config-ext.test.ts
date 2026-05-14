import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { EXT_SESSION_CONFIG } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedContextFile, seedProjectSettings } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];
beforeEach(() => {
	providers = [];
});
afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newFaux() {
	const faux = registerFauxProvider();
	providers.push(faux);
	faux.setResponses([() => fauxAssistantMessage("ok")]);
	return faux.getModel() as Model<Api>;
}

test("session/config returns resolved per-session config", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	await seedProjectSettings(
		filesystem,
		"/proj",
		JSON.stringify({ compaction: { reserveTokens: 99999 }, appendSystemPrompt: "FROM-PROJECT" }),
	);
	await seedContextFile(filesystem, "/proj", "AGENTS.md", "agents-content");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SESSION_CONFIG, { sessionId })) as {
		sessionId: string;
		cwd: string;
		defaultModelId: string;
		currentModelId: string;
		compaction: { reserveTokens: number };
		appendSystemPrompt: string | null;
		contextFilePaths: string[];
	};

	expect(result.sessionId).toBe(sessionId);
	expect(result.cwd).toBe("/proj");
	expect(result.defaultModelId).toBe(model.id);
	expect(result.currentModelId).toBe(model.id);
	expect(result.compaction.reserveTokens).toBe(99999);
	expect(result.appendSystemPrompt).toBe("FROM-PROJECT");
	expect(result.contextFilePaths).toEqual(["/proj/AGENTS.md"]);
});

test("session/config: defaults when no settings/AGENTS.md present", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SESSION_CONFIG, { sessionId })) as {
		appendSystemPrompt: string | null;
		contextFilePaths: string[];
	};
	expect(result.appendSystemPrompt).toBeNull();
	expect(result.contextFilePaths).toEqual([]);
});

test("session/config: host appendSystemPrompt beats project settings", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	await seedProjectSettings(filesystem, "/proj", JSON.stringify({ appendSystemPrompt: "FROM-PROJECT" }));
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		appendSystemPrompt: "FROM-HOST",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const result = (await harness.clientConn.extMethod(EXT_SESSION_CONFIG, { sessionId })) as {
		appendSystemPrompt: string | null;
	};
	expect(result.appendSystemPrompt).toBe("FROM-HOST");
});

test("session/config: rejects missing sessionId param", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await expect(harness.clientConn.extMethod(EXT_SESSION_CONFIG, {})).rejects.toThrow(/sessionId/);
});
