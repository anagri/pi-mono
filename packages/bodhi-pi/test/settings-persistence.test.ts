import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, createInMemorySessionStore, type Filesystem, type SessionStore } from "@/index.js";
import { EXT_SESSION_SETTINGS_GET, EXT_SESSION_SETTINGS_SET, EXT_SESSION_SETTINGS_UNSET } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
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

function startAgent(model: Model<Api>, sessionStore: SessionStore, filesystem: Filesystem) {
	return createTestHarness({ models: [model], defaultModelId: model.id, sessionStore, filesystem });
}

test("session-scope setting survives an agent rebuild (set → rebuild → resume → read back)", async () => {
	const model = newFaux();
	const sessionStore = createInMemorySessionStore();
	const filesystem = createInMemoryFilesystem();

	const first = startAgent(model, sessionStore, filesystem);
	await first.clientConn.initialize(stdInitParams);
	const { sessionId } = await first.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await first.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "appendSystemPrompt",
		value: "from-session",
		scope: "session",
	});

	const beforeRebuild = (await first.clientConn.extMethod(EXT_SESSION_SETTINGS_GET, {
		sessionId,
		key: "appendSystemPrompt",
	})) as { value: string | null; source: string };
	expect(beforeRebuild.value, "set in the first agent").toBe("from-session");
	expect(beforeRebuild.source).toBe("session");

	const record = await sessionStore.load(sessionId);
	const persisted = (record?.entries ?? []).filter((e) => e.type === "settings_change");
	expect(persisted.length, "a settings_change entry was persisted").toBe(1);

	const second = startAgent(model, sessionStore, filesystem);
	await second.clientConn.initialize(stdInitParams);
	await second.clientConn.resumeSession({ sessionId, cwd: "/proj" });

	const afterRebuild = (await second.clientConn.extMethod(EXT_SESSION_SETTINGS_GET, {
		sessionId,
		key: "appendSystemPrompt",
	})) as { value: string | null; source: string };
	expect(afterRebuild.value, "session-scope override survived the rebuild").toBe("from-session");
	expect(afterRebuild.source).toBe("session");
});

test("nested (dotted) session-scope key round-trips through rebuild", async () => {
	const model = newFaux();
	const sessionStore = createInMemorySessionStore();
	const filesystem = createInMemoryFilesystem();

	const first = startAgent(model, sessionStore, filesystem);
	await first.clientConn.initialize(stdInitParams);
	const { sessionId } = await first.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await first.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "compaction.reserveTokens",
		value: 12345,
		scope: "session",
	});

	const second = startAgent(model, sessionStore, filesystem);
	await second.clientConn.initialize(stdInitParams);
	await second.clientConn.resumeSession({ sessionId, cwd: "/proj" });

	const got = (await second.clientConn.extMethod(EXT_SESSION_SETTINGS_GET, {
		sessionId,
		key: "compaction.reserveTokens",
	})) as { value: unknown; source: string };
	expect(got.value).toBe(12345);
	expect(got.source).toBe("session");
});

test("session-scope unset persists across rebuild", async () => {
	const model = newFaux();
	const sessionStore = createInMemorySessionStore();
	const filesystem = createInMemoryFilesystem();

	const first = startAgent(model, sessionStore, filesystem);
	await first.clientConn.initialize(stdInitParams);
	const { sessionId } = await first.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await first.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId,
		key: "appendSystemPrompt",
		value: "x",
		scope: "session",
	});
	await first.clientConn.extMethod(EXT_SESSION_SETTINGS_UNSET, {
		sessionId,
		key: "appendSystemPrompt",
		scope: "session",
	});

	const second = startAgent(model, sessionStore, filesystem);
	await second.clientConn.initialize(stdInitParams);
	await second.clientConn.resumeSession({ sessionId, cwd: "/proj" });

	const got = (await second.clientConn.extMethod(EXT_SESSION_SETTINGS_GET, {
		sessionId,
		key: "appendSystemPrompt",
	})) as { value: unknown; source: string };
	expect(got.value).toBeNull();
	expect(got.source).not.toBe("session");
});
