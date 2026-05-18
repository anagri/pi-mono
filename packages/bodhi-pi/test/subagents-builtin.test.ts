import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, EXT_SUBAGENT_LIST, EXT_SUBAGENT_RUN } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedSubagent } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";

interface ListedProfile {
	name: string;
	description: string;
	source: "project" | "extension" | "builtin";
	body?: string;
}

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});

afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newProvider(): FauxProviderRegistration {
	const p = registerFauxProvider();
	providers.push(p);
	return p;
}

test("built-in explore + planner profiles are listed with source='builtin' when no project markdown exists", async () => {
	const filesystem = createInMemoryFilesystem();
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("noop")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const listResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: ListedProfile[];
	};
	const names = listResp.profiles.map((p) => p.name).sort();
	expect(names).toEqual(["explore", "planner"]);
	for (const p of listResp.profiles) {
		expect(p.source).toBe("builtin");
	}
});

test("built-in subagent tool can be spawned via _bodhi-pi/subagent/run with no project seed", async () => {
	const filesystem = createInMemoryFilesystem();
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("explored")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "explore",
		task: "inspect /proj",
	})) as { status: string; summary?: string };
	expect(result.status).toBe("completed");
	expect(result.summary).toContain("explored");
});

test("project markdown overrides a built-in by name and flips source to 'project'", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(
		filesystem,
		"/proj",
		"explore",
		"---\ndescription: my custom explorer\n---\nCustomized explore body.\n",
	);
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("noop")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const listResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: ListedProfile[];
	};
	const explore = listResp.profiles.find((p) => p.name === "explore");
	const planner = listResp.profiles.find((p) => p.name === "planner");
	expect(explore?.source).toBe("project");
	expect(explore?.description).toBe("my custom explorer");
	expect(planner?.source).toBe("builtin");
});

test("project markdown with disabled:true drops the matching built-in from the registry", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(
		filesystem,
		"/proj",
		"explore",
		"---\ndescription: disabled override\ndisabled: true\n---\nignored body.\n",
	);
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("noop")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const listResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: ListedProfile[];
	};
	const names = listResp.profiles.map((p) => p.name).sort();
	expect(names).toEqual(["planner"]);
});
