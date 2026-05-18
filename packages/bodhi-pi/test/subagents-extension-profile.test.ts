import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, EXT_SUBAGENT_LIST, EXT_SUBAGENT_RUN, type ExtensionFactory } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { asRegistered } from "./helpers/extension-fixtures.js";
import { seedSubagent } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";

interface ListedProfile {
	name: string;
	description: string;
	source: "project" | "extension" | "builtin";
}

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});

afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newModel(): Model<Api> {
	const p = registerFauxProvider();
	providers.push(p);
	p.setResponses([() => fauxAssistantMessage("noop")]);
	return p.getModel() as Model<Api>;
}

function dummyExtensionFactory(): ExtensionFactory {
	return (pi) => {
		pi.registerSubagentProfile({
			name: "dummy",
			description: "Extension-registered dummy profile",
			tools: ["read"],
			body: "You are dummy. Do nothing useful.",
		});
	};
}

test("extension-registered profile appears in list with source='extension'", async () => {
	const model = newModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		extensionFactories: [asRegistered("dummy-ext", dummyExtensionFactory())],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: ListedProfile[];
	};
	const dummy = res.profiles.find((p) => p.name === "dummy");
	expect(dummy?.source).toBe("extension");
	expect(dummy?.description).toBe("Extension-registered dummy profile");
});

test("project markdown overrides an extension-registered profile and flips source to 'project'", async () => {
	const model = newModel();
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "dummy", "---\ndescription: project wins\n---\nProject body.\n");
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		extensionFactories: [asRegistered("dummy-ext", dummyExtensionFactory())],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: ListedProfile[];
	};
	const dummy = res.profiles.find((p) => p.name === "dummy");
	expect(dummy?.source).toBe("project");
	expect(dummy?.description).toBe("project wins");
});

test("extension that registers a profile with disabled:true throws at registration", async () => {
	const badExt: ExtensionFactory = (pi) => {
		pi.registerSubagentProfile({
			name: "should-fail",
			description: "disabled at source",
			body: "x",
			disabled: true,
		});
	};
	const model = newModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		extensionFactories: [{ name: "bad-ext", factory: badExt }],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: ListedProfile[];
	};
	expect(res.profiles.find((p) => p.name === "should-fail")).toBeUndefined();
});

test("extension that registers a profile with context:'fork' throws at registration", async () => {
	const forkExt: ExtensionFactory = (pi) => {
		pi.registerSubagentProfile({
			name: "should-fail-fork",
			description: "fork-mode at extension surface",
			body: "x",
			...({ context: "fork" } as unknown as { context: "fresh" }),
		});
	};
	const model = newModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		extensionFactories: [{ name: "fork-ext", factory: forkExt }],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: ListedProfile[];
	};
	expect(res.profiles.find((p) => p.name === "should-fail-fork")).toBeUndefined();
});

test("extension overrides a built-in when no project markdown exists", async () => {
	const overrideExt: ExtensionFactory = (pi) => {
		pi.registerSubagentProfile({
			name: "explore",
			description: "Extension explore override",
			tools: ["read"],
			body: "I am the extension explore.",
		});
	};
	const model = newModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		extensionFactories: [asRegistered("explore-ext", overrideExt)],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: ListedProfile[];
	};
	const explore = res.profiles.find((p) => p.name === "explore");
	expect(explore?.source).toBe("extension");
	expect(explore?.description).toBe("Extension explore override");
});

test("extension-registered profile is spawnable via _bodhi-pi/subagent/run", async () => {
	const model = newModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		extensionFactories: [asRegistered("dummy-ext", dummyExtensionFactory())],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "dummy",
		task: "do nothing",
	})) as { status: string };
	expect(result.status).toBe("completed");
});
