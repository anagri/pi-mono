import { randomUUID } from "node:crypto";
import type { AgentSideConnection, McpServer } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { BodhiPiLogger } from "../acp/agent.js";
import type { EventDispatcher } from "../events/dispatcher.js";
import type { JsonValue, KvStore } from "../kv/kv-store.js";
import { maskSecrets } from "../kv/kv-store.js";
import type { AppendEntry } from "../models/registry.js";
import type { SessionState } from "../sessions/session-state.js";
import {
	EXT_MCP_ADD,
	EXT_MCP_CONNECT,
	EXT_MCP_DISCONNECT,
	EXT_MCP_EXCLUDE,
	EXT_MCP_INCLUDE,
	EXT_MCP_LIST,
	EXT_MCP_RECONNECT,
	EXT_MCP_REMOVE,
	EXT_MCP_TOOLS,
	LIFECYCLE_EVENT_METHOD,
} from "../wire/constants.js";
import { requireStringParam, validateSessionId } from "../wire/validators.js";
import type { McpConnectionProvider } from "./mcp-connection-provider.js";
import { McpRegistry } from "./mcp-registry.js";
import { resolveUniqueSlug, slugifyCommand, slugifyUrl } from "./mcp-slug.js";
import {
	MCP_PREFIX,
	type McpListEntry,
	type McpNamedSecret,
	type McpServerEntry,
	parseMcpServerEntry,
	serializeMcpServerEntry,
} from "./mcp-types.js";

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface McpServiceDeps {
	kvStore?: KvStore;
	events: EventDispatcher;
	conn: AgentSideConnection;
	sessions: Map<string, SessionState>;
	logger: BodhiPiLogger;
	supportsStdio?: boolean;
	provider: McpConnectionProvider;
	appendEntry: AppendEntry;
}

export class McpService {
	private readonly registry: McpRegistry;
	private readonly kvStore: KvStore | undefined;
	private readonly events: EventDispatcher;
	private readonly conn: AgentSideConnection;
	private readonly logger: BodhiPiLogger;
	private readonly supportsStdio: boolean;
	private readonly sessions: Map<string, SessionState>;
	private readonly provider: McpConnectionProvider;
	private readonly appendEntry: AppendEntry;

	constructor(deps: McpServiceDeps) {
		this.kvStore = deps.kvStore;
		this.events = deps.events;
		this.conn = deps.conn;
		this.logger = deps.logger;
		this.sessions = deps.sessions;
		this.supportsStdio = deps.supportsStdio ?? true;
		this.provider = deps.provider;
		this.appendEntry = deps.appendEntry;
		this.registry = new McpRegistry(deps.sessions, deps.provider);
		// When the host's provider mutates its connection map, refresh
		// piAgent.state.tools for every loaded session so newly-available /
		// removed tools propagate.
		this.provider.onChange(() => this.registry.applyToAllSessions());
	}

	register(): Array<[string, ExtHandler]> {
		return [
			[EXT_MCP_ADD, this.handleAdd.bind(this)],
			[EXT_MCP_REMOVE, this.handleRemove.bind(this)],
			[EXT_MCP_CONNECT, this.handleConnect.bind(this)],
			[EXT_MCP_DISCONNECT, this.handleDisconnect.bind(this)],
			[EXT_MCP_RECONNECT, this.handleReconnect.bind(this)],
			[EXT_MCP_LIST, this.handleList.bind(this)],
			[EXT_MCP_TOOLS, this.handleTools.bind(this)],
			[EXT_MCP_INCLUDE, this.handleInclude.bind(this)],
			[EXT_MCP_EXCLUDE, this.handleExclude.bind(this)],
		];
	}

	/**
	 * Set the session's inclusion based on `ephemeral` and the session-stored
	 * `restoredSlugs`. Precedence:
	 *   `ephemeral === undefined` → restoredSlugs (session-stored wins; no new entry written)
	 *   `ephemeral === []`        → empty (writes new snapshot entry)
	 *   `ephemeral === [A, B...]` → connect+include named slugs that exist in kv (writes new snapshot entry).
	 *                                Unknown slugs are silently skipped.
	 */
	async hydrate(sessionId: string, ephemeral: McpServer[] | undefined, restoredSlugs: string[] | null): Promise<void> {
		if (ephemeral === undefined) {
			const slugs = restoredSlugs ?? [];
			this.registry.setInclusion(sessionId, slugs);
			return;
		}

		if (ephemeral.length === 0) {
			this.registry.setInclusion(sessionId, []);
			// Only persist when there was a prior non-empty inclusion to override.
			// session/new with `[]` is the natural default; writing it would
			// pollute brand-new sessions with a noisy zero-state entry.
			if (restoredSlugs && restoredSlugs.length > 0) {
				await this.persistInclusion(sessionId, []);
			}
			return;
		}

		const persisted = await this.loadPersistedEntries();
		const persistedBySlug = new Map(persisted.map((p) => [p.slug, p.entry] as const));
		const referenced: string[] = [];
		for (const s of ephemeral) {
			const slug = sanitizeSlugForAcp(s.name);
			const entry = persistedBySlug.get(slug);
			if (!entry) continue;
			referenced.push(slug);
			if (!this.provider.isConnected(slug)) {
				try {
					await this.provider.connect(slug, entry);
					await this.persistStatus(slug, entry, "connected");
				} catch {
					// best-effort; surface via mcp_status_change below
				}
			}
		}
		this.registry.setInclusion(sessionId, referenced);
		await this.persistInclusion(sessionId, referenced);
	}

	closeSession(sessionId: string): void {
		this.registry.clearInclusion(sessionId);
	}

	private async handleAdd(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_ADD);
		const url = typeof params.url === "string" ? params.url : undefined;
		const command = typeof params.command === "string" ? params.command : undefined;
		if (!url && !command) {
			throw new RequestError(-32602, `${EXT_MCP_ADD}: either url or command is required`);
		}
		if (command && !this.supportsStdio) {
			throw new RequestError(-32601, `${EXT_MCP_ADD}: stdio MCPs are not supported on this runtime`);
		}
		const transport: "http" | "stdio" = url ? "http" : "stdio";
		const args = parseStringArray(params.args, `${EXT_MCP_ADD}: args`);
		const env = parseNamedSecretListParam(params.env);
		const label = typeof params.label === "string" && params.label.length > 0 ? params.label : undefined;
		const candidate = transport === "http" ? slugifyUrl(url ?? "") : slugifyCommand(command ?? "", args);
		const slug = await resolveUniqueSlug(candidate, kv);
		const entry: McpServerEntry = {
			transport,
			auth: { mode: "public" },
			label: label ?? slug,
			addedAt: new Date().toISOString(),
			lastKnownStatus: "disconnected",
		};
		if (url) entry.url = url;
		if (command) entry.command = command;
		if (args.length > 0) entry.args = args;
		if (env.length > 0) entry.env = env;
		await kv.set(`${MCP_PREFIX}${slug}`, serializeMcpServerEntry(entry));
		return { slug };
	}

	private async handleRemove(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_REMOVE);
		const slug = requireStringParam(EXT_MCP_REMOVE, params, "slug");
		await this.provider.disconnect(slug);
		await kv.remove(`${MCP_PREFIX}${slug}`);
		await this.emitStatusBroadcast(slug, "disconnected");
		return { slug };
	}

	private async handleConnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_CONNECT);
		const slug = requireStringParam(EXT_MCP_CONNECT, params, "slug");
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_CONNECT}: unknown mcp ${slug}`);
		if (this.provider.isConnected(slug)) {
			return { tools: this.provider.getToolNames(slug) ?? [] };
		}
		const result = await this.tryProviderConnect(slug, entry);
		await this.persistStatus(slug, entry, "connected");
		await this.emitStatusBroadcast(slug, "connected");
		await this.emitToolsBroadcast(slug, result.toolNames);
		return { tools: result.toolNames };
	}

	private async handleDisconnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_DISCONNECT);
		const slug = requireStringParam(EXT_MCP_DISCONNECT, params, "slug");
		await this.provider.disconnect(slug);
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (entry) await this.persistStatus(slug, entry, "disconnected");
		await this.emitStatusBroadcast(slug, "disconnected");
		return { slug };
	}

	private async handleReconnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_RECONNECT);
		const slug = requireStringParam(EXT_MCP_RECONNECT, params, "slug");
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_RECONNECT}: unknown mcp ${slug}`);
		const result = await this.tryProviderReconnect(slug, entry);
		await this.persistStatus(slug, entry, "connected");
		await this.emitStatusBroadcast(slug, "connected");
		await this.emitToolsBroadcast(slug, result.toolNames);
		return { tools: result.toolNames };
	}

	private async handleList(_params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_LIST);
		const entries = await kv.list(MCP_PREFIX);
		const out: McpListEntry[] = [];
		for (const e of entries) {
			const entry = parseMcpServerEntry(e.value);
			if (!entry) continue;
			const slug = e.key.slice(MCP_PREFIX.length);
			const liveStatus = this.provider.isConnected(slug) ? "connected" : entry.lastKnownStatus;
			const item: McpListEntry = {
				slug,
				label: entry.label,
				transport: entry.transport,
				status: liveStatus,
			};
			if (entry.url !== undefined) item.url = entry.url;
			if (entry.command !== undefined) item.command = entry.command;
			out.push(item);
		}
		return { entries: out as unknown as Record<string, unknown>[] };
	}

	private async handleTools(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const slug = requireStringParam(EXT_MCP_TOOLS, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_TOOLS, params);
		return { tools: this.registry.getVisibleToolNames(sessionId, slug) };
	}

	private async handleInclude(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_INCLUDE);
		const slug = requireStringParam(EXT_MCP_INCLUDE, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_INCLUDE, params);
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_INCLUDE}: unknown mcp ${slug}`);
		this.registry.addInclusion(sessionId, slug);
		await this.persistInclusion(sessionId, this.registry.getInclusion(sessionId));
		return { slug, tools: this.provider.isConnected(slug) ? (this.provider.getToolNames(slug) ?? []) : [] };
	}

	private async handleExclude(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const slug = requireStringParam(EXT_MCP_EXCLUDE, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_EXCLUDE, params);
		this.registry.removeInclusion(sessionId, slug);
		await this.persistInclusion(sessionId, this.registry.getInclusion(sessionId));
		return { slug };
	}

	private async tryProviderConnect(slug: string, entry: McpServerEntry): Promise<{ toolNames: string[] }> {
		try {
			return await this.provider.connect(slug, entry);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error(`[bodhi-pi mcp] connect ${slug} failed:`, message);
			await this.emitStatusBroadcast(slug, "error", message);
			throw new RequestError(-32603, `mcp/${slug}: ${message}`);
		}
	}

	private async tryProviderReconnect(slug: string, entry: McpServerEntry): Promise<{ toolNames: string[] }> {
		try {
			return await this.provider.reconnect(slug, entry);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error(`[bodhi-pi mcp] reconnect ${slug} failed:`, message);
			await this.emitStatusBroadcast(slug, "error", message);
			throw new RequestError(-32603, `mcp/${slug}: ${message}`);
		}
	}

	private async persistStatus(
		slug: string,
		entry: McpServerEntry,
		status: "connected" | "disconnected" | "error",
	): Promise<void> {
		const next = { ...entry, lastKnownStatus: status };
		await this.kvStore?.set(`${MCP_PREFIX}${slug}`, serializeMcpServerEntry(next));
	}

	private async persistInclusion(sessionId: string, slugs: string[]): Promise<void> {
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

	private async emitStatusBroadcast(
		slug: string,
		status: "connected" | "disconnected" | "error",
		errorMessage?: string,
	): Promise<void> {
		const sids = this.sessions.size === 0 ? [""] : Array.from(this.sessions.keys());
		for (const sessionId of sids) {
			await this.events.emit({
				type: "mcp_status_change",
				sessionId,
				slug,
				status,
				...(errorMessage !== undefined ? { errorMessage } : {}),
			});
			const params: Record<string, unknown> = {
				type: "mcp_status_change",
				sessionId,
				slug,
				status,
			};
			if (errorMessage !== undefined) params.errorMessage = errorMessage;
			await this.notifyLifecycle(params);
		}
	}

	private async emitToolsBroadcast(slug: string, toolNames: string[]): Promise<void> {
		const sids = this.sessions.size === 0 ? [""] : Array.from(this.sessions.keys());
		for (const sessionId of sids) {
			await this.events.emit({ type: "mcp_tools_change", sessionId, slug, toolNames });
			await this.notifyLifecycle({ type: "mcp_tools_change", sessionId, slug, toolNames });
		}
	}

	private async notifyLifecycle(params: Record<string, unknown>): Promise<void> {
		try {
			await (
				this.conn as unknown as {
					notification(params: { method: string; params: Record<string, unknown> }): Promise<void>;
				}
			).notification?.({ method: LIFECYCLE_EVENT_METHOD, params });
		} catch (err) {
			this.logger.error("[bodhi-pi mcp] lifecycle notify failed:", err);
		}
	}

	private requireKv(method: string): KvStore {
		if (!this.kvStore) {
			throw new RequestError(-32601, `${method}: kvStore not configured on this host`);
		}
		return this.kvStore;
	}

	private async loadPersistedEntries(): Promise<Array<{ slug: string; entry: McpServerEntry }>> {
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
}

function parseStringArray(value: unknown, errPrefix: string): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
	throw new RequestError(-32602, `${errPrefix} must be a string[]`);
}

function parseNamedSecretListParam(value: unknown): McpNamedSecret[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return [];
	const out: McpNamedSecret[] = [];
	for (const item of value) {
		if (item && typeof item === "object" && !Array.isArray(item)) {
			const o = item as { [k: string]: unknown };
			if (typeof o.name === "string" && typeof o.value === "string") {
				out.push({ name: o.name, value: o.value, secret: true });
			}
		}
	}
	return out;
}

function sanitizeSlugForAcp(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "mcp"
	);
}

export function maskedEntry(value: JsonValue): JsonValue {
	return maskSecrets(value);
}
