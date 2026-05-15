import { type ChildProcess, spawn } from "node:child_process";
import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { EXT_MCP_ADD, EXT_MCP_CONNECT, EXT_MCP_TOOLS } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

// Spawns mcp-everything in streamableHttp mode for the duration of the file.
// Verifies that bodhi-pi can: add an MCP entry, connect, discover tools, and
// expose them on `piAgent.state.tools` via the namespaced `<slug>__<tool>` format.

let server: ChildProcess | undefined;
let baseUrl: string;
let providers: FauxProviderRegistration[] = [];

const PORT = 33334;

beforeAll(async () => {
	server = spawn("npx", ["--yes", "@modelcontextprotocol/server-everything", "streamableHttp"], {
		env: { ...process.env, PORT: String(PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitForListening(server, /listening on port/, 30_000);
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

	const { tools } = (await harness.clientConn.extMethod(EXT_MCP_CONNECT, {
		sessionId,
		slug,
	})) as { tools: string[] };
	expect(tools.length).toBeGreaterThan(0);
	expect(tools.every((t) => t.startsWith(`${slug}__`))).toBe(true);
	// mcp-everything ships an `echo` tool; we expect at least that to be present.
	expect(tools).toContain(`${slug}__echo`);

	const listed = (await harness.clientConn.extMethod(EXT_MCP_TOOLS, { sessionId, slug })) as {
		tools: string[];
	};
	expect(listed.tools).toEqual(tools);
}, 30_000);

async function waitForListening(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error(`mcp-everything did not bind within ${timeoutMs}ms`)), timeoutMs);
		const onData = (chunk: Buffer | string) => {
			buf += chunk.toString();
			if (pattern.test(buf)) {
				clearTimeout(timer);
				child.stdout?.off("data", onData);
				child.stderr?.off("data", onData);
				resolve();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`mcp-everything exited before binding (code=${code})`));
		});
	});
}
