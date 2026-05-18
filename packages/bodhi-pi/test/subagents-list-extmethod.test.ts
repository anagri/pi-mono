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
	p.setResponses([fauxAssistantMessage("ok")]);
	return p.getModel() as Model<Api>;
}

test("_bodhi-pi/subagent/list returns built-ins when no project agents directory", async () => {
	const model = newModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: Array<{ name: string; source: string }>;
	};
	const names = res.profiles.map((p) => p.name).sort();
	expect(names).toEqual(["explore", "planner"]);
	for (const p of res.profiles) expect(p.source).toBe("builtin");
});

test("_bodhi-pi/subagent/list merges project profiles with built-ins", async () => {
	const model = newModel();
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(
		filesystem,
		"/proj",
		"extractor",
		"---\ndescription: Read a file and summarize\ntools:\n  - read\n---\nbody\n",
	);
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: Array<{ name: string; source: string }>;
	};
	expect(res.profiles.map((p) => p.name).sort()).toEqual(["explore", "extractor", "planner"]);
	expect(res.profiles.find((p) => p.name === "extractor")?.source).toBe("project");
	expect(res.profiles.find((p) => p.name === "explore")?.source).toBe("builtin");
});

test("_bodhi-pi/subagent/run rejects when agent name is unknown", async () => {
	const model = newModel();
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "extractor", "---\ndescription: x\n---\nbody\n");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await expect(
		harness.clientConn.extMethod(EXT_SUBAGENT_RUN, { sessionId, agent: "no-such-agent", task: "x" }),
	).rejects.toMatchObject({ code: -32602 });
});

test("subagent tool is registered when profiles exist and is included in available tools", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "extractor", "---\ndescription: x\n---\nbody\n");

	const faux = registerFauxProvider();
	providers.push(faux);
	const model = faux.getModel() as Model<Api>;
	const capturedTools: string[][] = [];
	faux.setResponses([
		(ctx) => {
			capturedTools.push((ctx.tools ?? []).map((t) => t.name));
			return fauxAssistantMessage("ok");
		},
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(capturedTools[0]).toContain("subagent");
});

test("subagent tool is NOT registered when every built-in is overridden with disabled:true", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "explore", "---\ndescription: off\ndisabled: true\n---\nignored.\n");
	await seedSubagent(filesystem, "/proj", "planner", "---\ndescription: off\ndisabled: true\n---\nignored.\n");

	const faux = registerFauxProvider();
	providers.push(faux);
	const model = faux.getModel() as Model<Api>;
	const capturedTools: string[][] = [];
	faux.setResponses([
		(ctx) => {
			capturedTools.push((ctx.tools ?? []).map((t) => t.name));
			return fauxAssistantMessage("ok");
		},
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(capturedTools[0]).not.toContain("subagent");
});
