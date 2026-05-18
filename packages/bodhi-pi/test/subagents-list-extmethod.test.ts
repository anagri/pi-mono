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

test("_bodhi-pi/subagent/list returns [] when no agents directory", async () => {
	const model = newModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: unknown[];
	};
	expect(res.profiles).toEqual([]);
});

test("_bodhi-pi/subagent/list returns parsed profiles", async () => {
	const model = newModel();
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(
		filesystem,
		"/proj",
		"extractor",
		"---\ndescription: Read a file and summarize\ntools:\n  - read\n---\nbody\n",
	);
	await seedSubagent(filesystem, "/proj", "planner", "---\ndescription: Make a plan\n---\nbody\n");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod(EXT_SUBAGENT_LIST, { sessionId })) as {
		profiles: Array<{ name: string; description: string; tools?: string[]; maxTurns: number; context: string }>;
	};
	expect(res.profiles).toEqual([
		{ name: "extractor", description: "Read a file and summarize", context: "fresh", tools: ["read"], maxTurns: 50 },
		{ name: "planner", description: "Make a plan", context: "fresh", maxTurns: 50 },
	]);
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

test("subagent tool is NOT registered when no profiles exist", async () => {
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

	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(capturedTools[0]).not.toContain("subagent");
});
