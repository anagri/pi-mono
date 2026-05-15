import type { AgentTool, Agent as PiAgent } from "@earendil-works/pi-agent-core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mergeTools } from "../extensions/merge.js";
import type { SessionState } from "../sessions/session-state.js";
import { adaptMcpTool } from "./mcp-tool-adapter.js";
import type { McpToolInfo } from "./mcp-types.js";

export interface ConnectedMcp {
	slug: string;
	client: Client;
	tools: AgentTool[];
	toolInfos: McpToolInfo[];
	close(): Promise<void>;
}

export class McpRegistry {
	private bySession = new Map<string, Map<string, ConnectedMcp>>();

	constructor(private readonly sessions: Map<string, SessionState>) {}

	add(
		sessionId: string,
		slug: string,
		client: Client,
		toolInfos: McpToolInfo[],
		close: () => Promise<void>,
	): ConnectedMcp {
		const tools = toolInfos.map((info) => adaptMcpTool(slug, info, client));
		const connected: ConnectedMcp = { slug, client, tools, toolInfos, close };
		const map = this.bySession.get(sessionId) ?? new Map<string, ConnectedMcp>();
		map.set(slug, connected);
		this.bySession.set(sessionId, map);
		this.applyToAgent(sessionId);
		return connected;
	}

	get(sessionId: string, slug: string): ConnectedMcp | undefined {
		return this.bySession.get(sessionId)?.get(slug);
	}

	has(sessionId: string, slug: string): boolean {
		return this.bySession.get(sessionId)?.has(slug) ?? false;
	}

	listSlugs(sessionId: string): string[] {
		const m = this.bySession.get(sessionId);
		return m ? Array.from(m.keys()) : [];
	}

	getTools(sessionId: string): AgentTool[] {
		const map = this.bySession.get(sessionId);
		if (!map) return [];
		const out: AgentTool[] = [];
		for (const c of map.values()) out.push(...c.tools);
		return out;
	}

	getToolInfos(sessionId: string, slug: string): McpToolInfo[] {
		return this.bySession.get(sessionId)?.get(slug)?.toolInfos ?? [];
	}

	async remove(sessionId: string, slug: string): Promise<void> {
		const map = this.bySession.get(sessionId);
		const connected = map?.get(slug);
		if (!connected) return;
		try {
			await connected.close();
		} catch {
			// best-effort
		}
		map?.delete(slug);
		if (map && map.size === 0) this.bySession.delete(sessionId);
		this.applyToAgent(sessionId);
	}

	async closeSession(sessionId: string): Promise<void> {
		const map = this.bySession.get(sessionId);
		if (!map) return;
		const closers = Array.from(map.values()).map(async (c) => {
			try {
				await c.close();
			} catch {
				// best-effort
			}
		});
		this.bySession.delete(sessionId);
		await Promise.all(closers);
	}

	applyToAgent(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		const merged = mergeTools(session.tools, this.getTools(sessionId));
		setAgentTools(session.runtime.piAgent, merged);
	}
}

function setAgentTools(piAgent: PiAgent, tools: AgentTool[]): void {
	piAgent.state.tools = tools;
}
