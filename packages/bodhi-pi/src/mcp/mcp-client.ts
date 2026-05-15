import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { BODHI_PI_VERSION } from "../version.js";
import { applyQueryParams, resolveHttpAuth, resolveStdioEnv } from "./mcp-auth.js";
import type { McpServerEntry, McpToolInfo } from "./mcp-types.js";

const CLIENT_INFO = { name: "bodhi-pi", version: BODHI_PI_VERSION };
// MV3 chrome ext / other CSP-restricted runtimes forbid `new Function` (Ajv default).
const SCHEMA_VALIDATOR = new CfWorkerJsonSchemaValidator();

export interface ConnectedClient {
	client: Client;
	tools: McpToolInfo[];
	close(): Promise<void>;
}

export async function connectMcp(entry: McpServerEntry): Promise<ConnectedClient> {
	const client = new Client(CLIENT_INFO, { jsonSchemaValidator: SCHEMA_VALIDATOR });
	if (entry.transport === "http") {
		if (!entry.url) throw new Error("http MCP entry missing url");
		const { headers, queryParams } = resolveHttpAuth(entry.auth);
		const url = new URL(applyQueryParams(entry.url, queryParams));
		const transport = new StreamableHTTPClientTransport(url, {
			requestInit: { headers },
		});
		await client.connect(transport);
	} else {
		if (!entry.command) throw new Error("stdio MCP entry missing command");
		// dynamic import keeps node:child_process out of browser bundles.
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		const transport = new StdioClientTransport({
			command: entry.command,
			args: entry.args ?? [],
			env: resolveStdioEnv(entry.env),
		});
		await client.connect(transport);
	}
	const tools = await listTools(client);
	return {
		client,
		tools,
		close: async () => {
			try {
				await client.close();
			} catch {
				// best-effort
			}
		},
	};
}

async function listTools(client: Client): Promise<McpToolInfo[]> {
	const res = await client.listTools();
	const list: McpToolInfo[] = [];
	for (const t of res.tools ?? []) {
		const tool: McpToolInfo = { name: t.name };
		if (typeof t.description === "string") tool.description = t.description;
		if (t.inputSchema) tool.inputSchema = t.inputSchema as unknown as McpToolInfo["inputSchema"];
		list.push(tool);
	}
	return list;
}

export async function callMcpTool(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<{ content: unknown; isError: boolean }> {
	const result = await client.callTool({ name, arguments: args });
	const content = result.content as unknown;
	const isError = result.isError === true;
	return { content, isError };
}
