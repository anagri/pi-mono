import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpServerEntry, McpToolInfo } from "./mcp-types.js";

export interface McpProviderConnectResult {
	toolNames: string[];
}

/**
 * Host-injected interface owning MCP connection lifecycle. The SDK delegates
 * `_bodhi-pi/mcp/{connect,disconnect,reconnect}` to the provider and reads
 * tools/status via the read-side methods.
 *
 * Lifetime is host-defined:
 *  - single-tenant in-process hosts (cli, in-memory) use the default
 *    `createInProcessMcpConnectionProvider()` shipped by the SDK.
 *  - multi-tenant server hosts (test-app-http, ws-server) keep a
 *    `Map<userId, McpConnectionProvider>` at process scope so connections
 *    survive per-request agent rebuild.
 *  - worker hosts (browser, chrome-ext) wrap the in-process provider with a
 *    storage-mirror so page-refresh / extension-reload can restore.
 */
export interface McpConnectionProvider {
	// Lifecycle — SDK auto-wires these as ACP ext methods.
	connect(slug: string, entry: McpServerEntry): Promise<McpProviderConnectResult>;
	disconnect(slug: string): Promise<void>;
	reconnect(slug: string, entry: McpServerEntry): Promise<McpProviderConnectResult>;

	// Reads — SDK consults these for piAgent.state.tools merge and the
	// `_bodhi-pi/mcp/{tools,list}` extension method responses.
	getTools(slug: string): AgentTool[] | undefined;
	getToolNames(slug: string): string[] | undefined;
	getToolInfos(slug: string): McpToolInfo[] | undefined;
	isConnected(slug: string): boolean;
	listConnectedSlugs(): string[];

	// SDK subscribes; host fires when its connection map changes so the SDK
	// can refresh piAgent.state.tools across all loaded sessions.
	onChange(handler: () => void): () => void;
}
