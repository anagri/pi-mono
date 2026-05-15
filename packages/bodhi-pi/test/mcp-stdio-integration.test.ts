import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_MCP_ADD, EXT_MCP_CONNECT, EXT_MCP_TOOLS } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

// Drives a real stdio MCP server (mcp-everything in stdio mode) launched by
// the SDK's `StdioClientTransport` as a child process. Asserts that the agent
// can list and namespace its tools through the same path as http.

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

	const { tools } = (await harness.clientConn.extMethod(EXT_MCP_CONNECT, {
		sessionId,
		slug,
	})) as { tools: string[] };
	expect(tools.length).toBeGreaterThan(0);
	expect(tools).toContain(`${slug}__echo`);

	const listed = (await harness.clientConn.extMethod(EXT_MCP_TOOLS, { sessionId, slug })) as {
		tools: string[];
	};
	expect(listed.tools).toEqual(tools);
}, 60_000);
