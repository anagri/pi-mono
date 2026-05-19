import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createBodhiPiClient } from "@/client/client.js";
import type { BodhiPiAcpConnection } from "@/client/types.js";
import type { McpConnectionProvider } from "@/mcp/mcp-connection-provider.js";
import type { McpToolInfo } from "@/mcp/mcp-types.js";
import { LIFECYCLE_EVENT_METHOD } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness, type TestHarness } from "./helpers/harness.js";

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

function modelOf(faux: FauxProviderRegistration): Model<Api> {
	return faux.getModel() as Model<Api>;
}

function bindClient(harness: TestHarness) {
	return createBodhiPiClient(harness.clientConn as unknown as BodhiPiAcpConnection);
}

/**
 * In-memory stub provider that surfaces pre-baked tools with annotations.
 * No real MCP server is dialled; `connect()` is a no-op recorder.
 */
function stubMcpProvider(slug: string, toolInfos: McpToolInfo[]): McpConnectionProvider {
	const tools: AgentTool[] = toolInfos.map(
		(info) =>
			({
				name: `${slug}__${info.name}`,
				label: `mcp:${slug}:${info.name}`,
				description: info.description ?? `stub ${info.name}`,
				parameters: { type: "object", properties: {}, additionalProperties: true },
				execute: async () => ({
					content: [{ type: "text", text: `${info.name} executed` }],
					isError: false,
					details: undefined,
				}),
			}) as unknown as AgentTool,
	);
	return {
		connect: async () => ({ toolNames: tools.map((t) => t.name) }),
		disconnect: async () => {},
		reconnect: async () => ({ toolNames: tools.map((t) => t.name) }),
		getTools: (s) => (s === slug ? tools : undefined),
		getToolNames: (s) => (s === slug ? tools.map((t) => t.name) : undefined),
		getToolInfos: (s) => (s === slug ? toolInfos : undefined),
		isConnected: (s) => s === slug,
		listConnectedSlugs: () => [slug],
		onChange: () => () => {},
	};
}

test("plan mode allows MCP tool with readOnlyHint=true", async () => {
	const faux = newProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("github__list_issues", { repo: "x/y" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		defaultMode: "plan",
		mcpConnectionProvider: stubMcpProvider("github", [{ name: "list_issues", annotations: { readOnlyHint: true } }]),
	});
	const client = bindClient(harness);

	await client.initialize(stdInitParams);
	const { sessionId } = await client.newSession({ cwd: "/proj", mcpServers: [] });
	await client.mcpAdd({ url: "https://mcp.github.com/mcp", auth: "public" });
	await client.mcpInclude({ sessionId, slug: "github" });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "list it" }] });

	const blocked = harness.extNotifications.filter(
		(n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === "tool_blocked",
	);
	expect(blocked, "readOnlyHint=true → allowed in plan mode").toHaveLength(0);
});

test("plan mode denies MCP tool with destructiveHint=true", async () => {
	const faux = newProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("github__delete_repo", { repo: "x/y" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("adapted"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		defaultMode: "plan",
		mcpConnectionProvider: stubMcpProvider("github", [
			{ name: "delete_repo", annotations: { destructiveHint: true } },
		]),
	});
	const client = bindClient(harness);

	await client.initialize(stdInitParams);
	const { sessionId } = await client.newSession({ cwd: "/proj", mcpServers: [] });
	await client.mcpAdd({ url: "https://mcp.github.com/mcp", auth: "public" });
	await client.mcpInclude({ sessionId, slug: "github" });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "delete it" }] });

	const blocked = harness.extNotifications.filter(
		(n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === "tool_blocked",
	);
	expect(blocked).toHaveLength(1);
	const payload = blocked[0].params as { toolName: string; category: string; reason: string };
	expect(payload.toolName).toBe("github__delete_repo");
	expect(payload.category).toBe("mcp");
	expect(payload.reason).toContain("plan mode");
});

test("plan mode allows MCP tool with no annotations (research-permissive default)", async () => {
	const faux = newProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("github__unknown", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		defaultMode: "plan",
		// No annotations on the tool.
		mcpConnectionProvider: stubMcpProvider("github", [{ name: "unknown" }]),
	});
	const client = bindClient(harness);

	await client.initialize(stdInitParams);
	const { sessionId } = await client.newSession({ cwd: "/proj", mcpServers: [] });
	await client.mcpAdd({ url: "https://mcp.github.com/mcp", auth: "public" });
	await client.mcpInclude({ sessionId, slug: "github" });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	const blocked = harness.extNotifications.filter(
		(n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === "tool_blocked",
	);
	expect(blocked, "absent annotations → default-allow in plan mode").toHaveLength(0);
});
