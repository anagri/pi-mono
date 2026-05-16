import { randomUUID } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk";
import type { KvStore } from "../kv/kv-store.js";
import type { AppendEntry } from "../models/registry.js";
import type { SessionState } from "../sessions/session-state.js";
import { MCP_PREFIX, type McpServerEntry, parseMcpServerEntry, serializeMcpServerEntry } from "./mcp-types.js";

export interface McpStoreDeps {
	kvStore?: KvStore;
	sessions: Map<string, SessionState>;
	appendEntry: AppendEntry;
}

/** kv + session-log persistence for MCP. No transport, no broadcasting. */
export class McpStore {
	private readonly kvStore: KvStore | undefined;
	private readonly sessions: Map<string, SessionState>;
	private readonly appendEntry: AppendEntry;

	constructor(deps: McpStoreDeps) {
		this.kvStore = deps.kvStore;
		this.sessions = deps.sessions;
		this.appendEntry = deps.appendEntry;
	}

	requireKv(method: string): KvStore {
		if (!this.kvStore) {
			throw new RequestError(-32601, `${method}: kvStore not configured on this host`);
		}
		return this.kvStore;
	}

	async loadPersistedEntries(): Promise<Array<{ slug: string; entry: McpServerEntry }>> {
		if (!this.kvStore) return [];
		const rows = await this.kvStore.list(MCP_PREFIX);
		const out: Array<{ slug: string; entry: McpServerEntry }> = [];
		for (const row of rows) {
			const entry = parseMcpServerEntry(row.value);
			if (!entry) continue;
			out.push({ slug: row.key.slice(MCP_PREFIX.length), entry });
		}
		return out;
	}

	async persistStatus(
		slug: string,
		entry: McpServerEntry,
		status: "connected" | "disconnected" | "error",
	): Promise<void> {
		const next = { ...entry, lastKnownStatus: status };
		await this.kvStore?.set(`${MCP_PREFIX}${slug}`, serializeMcpServerEntry(next));
	}

	async persistInclusion(sessionId: string, slugs: string[]): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		const sorted = slugs.slice().sort();
		await this.appendEntry(sessionId, session, {
			type: "mcp_inclusion_set",
			id: randomUUID(),
			parentId: session.runtime.leafId,
			timestamp: Date.now(),
			slugs: sorted,
		});
	}
}
