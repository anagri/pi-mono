import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_MCP_ADD, EXT_MCP_CONNECT, EXT_MCP_INCLUDE, EXT_MCP_LIST, EXT_MCP_TOOLS } from "@/wire/constants.js";
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

test("MCP stdio: add → connect spawns the server, lists tools namespaced as <slug>__<tool>", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const { slug } = (await harness.clientConn.extMethod(EXT_MCP_ADD, {
		command: "npx",
		args: ["--yes", "@modelcontextprotocol/server-everything", "stdio"],
	})) as { slug: string };
	expect(slug).toBe("server-everything");

	const { tools } = (await harness.clientConn.extMethod(EXT_MCP_CONNECT, { slug })) as { tools: string[] };
	expect(tools.length).toBeGreaterThan(0);
	expect(tools).toContain(`${slug}__echo`);

	await harness.clientConn.extMethod(EXT_MCP_INCLUDE, { sessionId, slug });
	const listed = (await harness.clientConn.extMethod(EXT_MCP_TOOLS, { sessionId, slug })) as {
		tools: string[];
	};
	expect(listed.tools).toEqual(tools);
}, 60_000);

test("MCP stdio: add rejects auth: 'http-param' with -32602", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await expect(
		harness.clientConn.extMethod(EXT_MCP_ADD, {
			command: "npx",
			args: ["--yes", "@modelcontextprotocol/server-everything", "stdio"],
			auth: "http-param",
			headers: { Authorization: "Bearer x" },
		}),
	).rejects.toMatchObject({ code: -32602 });
});

test("MCP stdio: add rejects sibling headers/queries with no auth field", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await expect(
		harness.clientConn.extMethod(EXT_MCP_ADD, {
			command: "npx",
			args: ["--yes", "@modelcontextprotocol/server-everything", "stdio"],
			headers: { Authorization: "Bearer x" },
		}),
	).rejects.toMatchObject({ code: -32602 });
});

test("MCP stdio: /mcp list response does not expose persisted env values", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.extMethod(EXT_MCP_ADD, {
		command: "echo",
		args: ["noop"],
		env: [{ name: "API_KEY", value: "supersecret" }],
	});
	const list = (await harness.clientConn.extMethod(EXT_MCP_LIST, {})) as {
		entries: Array<Record<string, unknown>>;
	};
	const entry = list.entries.find((e) => e.command === "echo");
	expect(entry).toBeDefined();
	expect(JSON.stringify(entry)).not.toContain("supersecret");
});
