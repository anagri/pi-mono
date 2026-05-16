import type { ChildProcess } from "node:child_process";
import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { EXT_MCP_ADD, EXT_MCP_CONNECT, EXT_MCP_INCLUDE, EXT_MCP_TOOLS } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";
import { spawnMcpEverythingHttp } from "./helpers/spawn-mcp-everything.js";

let server: ChildProcess | undefined;
let baseUrl: string;
let providers: FauxProviderRegistration[] = [];

const PORT = 33334;

beforeAll(async () => {
	server = await spawnMcpEverythingHttp(PORT);
	baseUrl = `http://localhost:${PORT}/mcp`;
}, 60_000);

afterAll(async () => {
	if (server && !server.killed) {
		server.kill("SIGTERM");
		await new Promise<void>((resolve) => server!.once("exit", () => resolve()));
	}
});

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

test("MCP http-streamable: add → connect surfaces server tools on piAgent.state.tools", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const { slug } = (await harness.clientConn.extMethod(EXT_MCP_ADD, { url: baseUrl })) as { slug: string };
	expect(slug.length).toBeGreaterThan(0);

	const { tools } = (await harness.clientConn.extMethod(EXT_MCP_CONNECT, { slug })) as { tools: string[] };
	expect(tools.length).toBeGreaterThan(0);
	expect(tools.every((t) => t.startsWith(`${slug}__`))).toBe(true);
	// mcp-everything ships an `echo` tool; we expect at least that to be present.
	expect(tools).toContain(`${slug}__echo`);

	await harness.clientConn.extMethod(EXT_MCP_INCLUDE, { sessionId, slug });
	const listed = (await harness.clientConn.extMethod(EXT_MCP_TOOLS, { sessionId, slug })) as {
		tools: string[];
	};
	expect(listed.tools).toEqual(tools);
}, 30_000);
