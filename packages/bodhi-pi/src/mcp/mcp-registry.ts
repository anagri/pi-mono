import type { AgentTool, Agent as PiAgent } from "@earendil-works/pi-agent-core";
import { mergeTools } from "../extensions/merge.js";
import type { SessionState } from "../sessions/session-state.js";
import type { McpConnectionProvider } from "./mcp-connection-provider.js";
import { parseToolName } from "./mcp-tool-adapter.js";
import type { McpToolAnnotations } from "./mcp-types.js";

/**
 * Per-agent registry for **inclusion** (which slugs each session has opted in
 * to surface tools from). Connection ownership lives entirely in the
 * host-injected `McpConnectionProvider`; this class only tracks per-session
 * inclusion and fans out `piAgent.state.tools` refreshes.
 */
export class McpRegistry {
	private inclusion = new Map<string, Set<string>>();

	constructor(
		private readonly sessions: Map<string, SessionState>,
		private readonly provider: McpConnectionProvider,
	) {}

	setInclusion(sessionId: string, slugs: Iterable<string>): void {
		this.inclusion.set(sessionId, new Set(slugs));
		this.applyToSession(sessionId);
	}

	addInclusion(sessionId: string, slug: string): void {
		const set = this.inclusion.get(sessionId) ?? new Set<string>();
		set.add(slug);
		this.inclusion.set(sessionId, set);
		this.applyToSession(sessionId);
	}

	removeInclusion(sessionId: string, slug: string): void {
		const set = this.inclusion.get(sessionId);
		if (!set) return;
		set.delete(slug);
		this.applyToSession(sessionId);
	}

	getInclusion(sessionId: string): string[] {
		const set = this.inclusion.get(sessionId);
		return set ? Array.from(set) : [];
	}

	clearInclusion(sessionId: string): void {
		this.inclusion.delete(sessionId);
	}

	/** Tools visible to `sessionId`: union over (included ∩ connected) slugs. */
	getVisibleTools(sessionId: string): AgentTool[] {
		const set = this.inclusion.get(sessionId);
		if (!set || set.size === 0) return [];
		const out: AgentTool[] = [];
		for (const slug of set) {
			const tools = this.provider.getTools(slug);
			if (tools) out.push(...tools);
		}
		return out;
	}

	/** Tool names for `(sessionId, slug)`. Returns [] when slug isn't included OR isn't connected. */
	getVisibleToolNames(sessionId: string, slug: string): string[] {
		const set = this.inclusion.get(sessionId);
		if (!set || !set.has(slug)) return [];
		return this.provider.getToolNames(slug) ?? [];
	}

	/**
	 * Resolve MCP tool annotations for a namespaced `<slug>__<tool>` name. Returns `undefined`
	 * when the name is malformed, the slug isn't included for the session, the slug isn't
	 * connected, the tool name isn't known, or the tool carries no annotations.
	 */
	getToolAnnotations(sessionId: string, fullName: string): McpToolAnnotations | undefined {
		const parsed = parseToolName(fullName);
		if (!parsed) return undefined;
		const set = this.inclusion.get(sessionId);
		if (!set || !set.has(parsed.slug)) return undefined;
		const infos = this.provider.getToolInfos(parsed.slug);
		return infos?.find((t) => t.name === parsed.original)?.annotations;
	}

	applyToSession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		const merged = mergeTools(session.tools, this.getVisibleTools(sessionId));
		setAgentTools(session.runtime.piAgent, merged);
	}

	applyToAllSessions(): void {
		for (const sessionId of this.sessions.keys()) {
			this.applyToSession(sessionId);
		}
	}
}

function setAgentTools(piAgent: PiAgent, tools: AgentTool[]): void {
	piAgent.state.tools = tools;
}
