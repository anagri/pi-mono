import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ConnectedClient, connectMcp } from "./mcp-client.js";
import type { McpConnectionProvider, McpProviderConnectResult } from "./mcp-connection-provider.js";
import { adaptMcpTool, toolName } from "./mcp-tool-adapter.js";
import type { McpServerEntry, McpToolInfo } from "./mcp-types.js";

interface InProcessEntry {
	client: ConnectedClient["client"];
	tools: AgentTool[];
	toolInfos: McpToolInfo[];
	close(): Promise<void>;
}

/**
 * Default `McpConnectionProvider` shipped by the SDK. Owns a process-local
 * `Map<slug, ...>`. Suitable for single-tenant embedded hosts (cli, in-memory)
 * and as the inner state-holder for worker-scoped hosts.
 *
 * The implementation calls `connectMcp` from `mcp-client.ts` to dial the
 * underlying transport; tools are adapted via `adaptMcpTool`.
 */
export function createInProcessMcpConnectionProvider(): McpConnectionProvider {
	const bySlug = new Map<string, InProcessEntry>();
	const subs = new Set<() => void>();
	const fire = () => {
		for (const fn of subs) {
			try {
				fn();
			} catch {
				// best-effort
			}
		}
	};

	async function connectSlug(slug: string, entry: McpServerEntry): Promise<McpProviderConnectResult> {
		const connected = await connectMcp(entry, {
			onTransportClose: () => {
				if (!bySlug.has(slug)) return;
				bySlug.delete(slug);
				fire();
			},
		});
		const tools = connected.tools.map((info) => adaptMcpTool(slug, info, connected.client));
		bySlug.set(slug, {
			client: connected.client,
			tools,
			toolInfos: connected.tools,
			close: connected.close,
		});
		fire();
		return { toolNames: connected.tools.map((t) => toolName(slug, t.name)) };
	}

	async function disconnectSlug(slug: string): Promise<void> {
		const existing = bySlug.get(slug);
		if (!existing) return;
		bySlug.delete(slug);
		try {
			await existing.close();
		} catch {
			// best-effort
		}
		fire();
	}

	return {
		async connect(slug, entry) {
			if (bySlug.has(slug)) {
				const existing = bySlug.get(slug);
				if (!existing) return { toolNames: [] };
				return { toolNames: existing.toolInfos.map((t) => toolName(slug, t.name)) };
			}
			return await connectSlug(slug, entry);
		},
		disconnect: disconnectSlug,
		async reconnect(slug, entry) {
			await disconnectSlug(slug);
			return await connectSlug(slug, entry);
		},
		getTools(slug) {
			return bySlug.get(slug)?.tools;
		},
		getToolNames(slug) {
			const e = bySlug.get(slug);
			return e ? e.toolInfos.map((t) => toolName(slug, t.name)) : undefined;
		},
		getToolInfos(slug) {
			return bySlug.get(slug)?.toolInfos;
		},
		isConnected(slug) {
			return bySlug.has(slug);
		},
		listConnectedSlugs() {
			return Array.from(bySlug.keys());
		},
		onChange(handler) {
			subs.add(handler);
			return () => subs.delete(handler);
		},
	};
}
