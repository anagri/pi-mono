import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, EXT_SUBAGENT_RUN, LIFECYCLE_EVENT_METHOD } from "@/index.js";
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

test("subagent_start and subagent_end are forwarded over the wire via LIFECYCLE_EVENT_METHOD", async () => {
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

	const lifecycle = harness.extNotifications.filter((n) => n.method === LIFECYCLE_EVENT_METHOD);
	const types = lifecycle.map((n) => (n.params as { type?: string }).type ?? "?");
	expect(types).toContain("subagent_start");
	expect(types).toContain("subagent_end");

	const startEv = lifecycle.find((n) => (n.params as { type?: string }).type === "subagent_start")?.params as {
		childSessionId?: string;
		profile?: string;
		parentSessionId?: string;
	};
	expect(startEv?.childSessionId).toBe(result.childSessionId);
	expect(startEv?.profile).toBe("echo");
	expect(startEv?.parentSessionId).toBe(sessionId);

	const endEv = lifecycle.find((n) => (n.params as { type?: string }).type === "subagent_end")?.params as {
		childSessionId?: string;
		status?: string;
	};
	expect(endEv?.childSessionId).toBe(result.childSessionId);
	expect(endEv?.status).toBe("completed");
});
