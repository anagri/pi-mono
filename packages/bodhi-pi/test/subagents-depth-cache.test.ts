import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, EXT_SUBAGENT_RUN } from "@/index.js";
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

function newProvider(): FauxProviderRegistration {
	const p = registerFauxProvider();
	providers.push(p);
	return p;
}

test("spawn from a top-level parent records subagent_link.depth === 1", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "echo", "---\ndescription: echo\n---\nYou echo.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("child done")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "echo",
		task: "do",
	})) as { childSessionId: string; status: string };
	expect(result.status).toBe("completed");

	const childRecord = await harness.sessionStore.load(result.childSessionId);
	expect(childRecord).toBeDefined();
	const link = childRecord!.entries.find((e) => e.type === "subagent_link");
	expect(link).toMatchObject({ type: "subagent_link", depth: 1 });
});

test("repeated spawns from the same top-level parent always record depth === 1 (cached, no entry walking)", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "echo", "---\ndescription: echo\n---\nYou echo.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		() => fauxAssistantMessage("first child done"),
		() => fauxAssistantMessage("second child done"),
		() => fauxAssistantMessage("third child done"),
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	for (let i = 0; i < 3; i++) {
		const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
			sessionId,
			agent: "echo",
			task: `iteration ${i}`,
		})) as { childSessionId: string; status: string };
		expect(result.status).toBe("completed");
		const child = await harness.sessionStore.load(result.childSessionId);
		const link = child!.entries.find((e) => e.type === "subagent_link");
		expect(link).toMatchObject({ depth: 1 });
	}
});
