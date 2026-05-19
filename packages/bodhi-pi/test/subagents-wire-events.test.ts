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

test("subagent_start and subagent_end are forwarded over the wire via LIFECYCLE_EVENT_METHOD with contextMode='fresh'", async () => {
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
		profileName?: string;
		parentSessionId?: string;
		contextMode?: string;
	};
	expect(startEv?.childSessionId).toBe(result.childSessionId);
	expect(startEv?.profileName).toBe("echo");
	expect(startEv?.parentSessionId).toBe(sessionId);
	expect(startEv?.contextMode).toBe("fresh");

	const endEv = lifecycle.find((n) => (n.params as { type?: string }).type === "subagent_end")?.params as {
		childSessionId?: string;
		status?: string;
		contextMode?: string;
	};
	expect(endEv?.childSessionId).toBe(result.childSessionId);
	expect(endEv?.status).toBe("completed");
	expect(endEv?.contextMode).toBe("fresh");
});

test("subagent_start and subagent_end carry contextMode='fork' when spawned via a fork profile", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "reviewer", "---\ndescription: review\ncontext: fork\n---\nYou review.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("reviewer done")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "reviewer",
		task: "do",
	})) as { childSessionId: string; status: string };
	expect(result.status).toBe("completed");

	const lifecycle = harness.extNotifications.filter((n) => n.method === LIFECYCLE_EVENT_METHOD);
	const startEv = lifecycle.find((n) => (n.params as { type?: string }).type === "subagent_start")?.params as {
		contextMode?: string;
	};
	const endEv = lifecycle.find((n) => (n.params as { type?: string }).type === "subagent_end")?.params as {
		contextMode?: string;
	};
	expect(startEv?.contextMode).toBe("fork");
	expect(endEv?.contextMode).toBe("fork");
});

test("wire-forwarded lifecycle events carry serverTime stamped by the event factory", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "echo", "---\ndescription: echo\n---\nYou echo.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("child done")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const before = Date.now();
	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "echo",
		task: "do",
	})) as { status: string };
	expect(result.status).toBe("completed");
	const after = Date.now();

	const lifecycle = harness.extNotifications.filter((n) => n.method === LIFECYCLE_EVENT_METHOD);
	const startEv = lifecycle.find((n) => (n.params as { type?: string }).type === "subagent_start")?.params as {
		serverTime?: number;
	};
	const endEv = lifecycle.find((n) => (n.params as { type?: string }).type === "subagent_end")?.params as {
		serverTime?: number;
	};
	expect(typeof startEv?.serverTime).toBe("number");
	expect(typeof endEv?.serverTime).toBe("number");
	expect(startEv?.serverTime).toBeGreaterThanOrEqual(before);
	expect(endEv?.serverTime).toBeLessThanOrEqual(after);
	expect(startEv?.serverTime ?? 0).toBeLessThanOrEqual(endEv?.serverTime ?? 0);
});
