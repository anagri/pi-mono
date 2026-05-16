import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { BodhiPiLogger } from "../acp/agent.js";
import type { EventDispatcher } from "../events/dispatcher.js";
import type { KvStore } from "../kv/kv-store.js";
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
} from "../wire/constants.js";
import { requireStringParam, validateSessionId } from "../wire/validators.js";
import { McpConnectionLifecycle } from "./mcp-connection-lifecycle.js";
import type { McpConnectionProvider } from "./mcp-connection-provider.js";
import { McpRegistry } from "./mcp-registry.js";
import { resolveUniqueSlug, slugifyCommand, slugifyUrl } from "./mcp-slug.js";
import { McpStore } from "./mcp-store.js";
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
	private readonly store: McpStore;
	private readonly lifecycle: McpConnectionLifecycle;
	private readonly registry: McpRegistry;
	private readonly provider: McpConnectionProvider;
	private readonly supportsStdio: boolean;

	constructor(deps: McpServiceDeps) {
		this.supportsStdio = deps.supportsStdio ?? true;
		this.provider = deps.provider;
		this.store = new McpStore({
			kvStore: deps.kvStore,
			sessions: deps.sessions,
			appendEntry: deps.appendEntry,
		});
		this.registry = new McpRegistry(deps.sessions, deps.provider);
		this.lifecycle = new McpConnectionLifecycle({
			events: deps.events,
			conn: deps.conn,
			sessions: deps.sessions,
			provider: deps.provider,
			logger: deps.logger,
			store: this.store,
			registry: this.registry,
		});
		// Host's provider mutates its connection map → refresh piAgent.state.tools for every loaded session.
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

	hydrate(
		sessionId: string,
		ephemeral: Parameters<McpConnectionLifecycle["hydrate"]>[1],
		restoredSlugs: string[] | null,
	): Promise<void> {
		return this.lifecycle.hydrate(sessionId, ephemeral, restoredSlugs);
	}

	closeSession(sessionId: string): void {
		this.lifecycle.closeSession(sessionId);
	}

	private async handleAdd(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_ADD);
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
		const kv = this.store.requireKv(EXT_MCP_REMOVE);
		const slug = requireStringParam(EXT_MCP_REMOVE, params, "slug");
		await this.provider.disconnect(slug);
		await kv.remove(`${MCP_PREFIX}${slug}`);
		await this.lifecycle.emitStatusBroadcast(slug, "disconnected");
		return { slug };
	}

	private async handleConnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_CONNECT);
		const slug = requireStringParam(EXT_MCP_CONNECT, params, "slug");
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_CONNECT}: unknown mcp ${slug}`);
		if (this.provider.isConnected(slug)) {
			return { tools: this.provider.getToolNames(slug) ?? [] };
		}
		const result = await this.lifecycle.tryProviderConnect(slug, entry);
		await this.store.persistStatus(slug, entry, "connected");
		await this.lifecycle.emitStatusBroadcast(slug, "connected");
		await this.lifecycle.emitToolsBroadcast(slug, result.toolNames);
		return { tools: result.toolNames };
	}

	private async handleDisconnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_DISCONNECT);
		const slug = requireStringParam(EXT_MCP_DISCONNECT, params, "slug");
		await this.provider.disconnect(slug);
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (entry) await this.store.persistStatus(slug, entry, "disconnected");
		await this.lifecycle.emitStatusBroadcast(slug, "disconnected");
		return { slug };
	}

	private async handleReconnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_RECONNECT);
		const slug = requireStringParam(EXT_MCP_RECONNECT, params, "slug");
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_RECONNECT}: unknown mcp ${slug}`);
		const result = await this.lifecycle.tryProviderReconnect(slug, entry);
		await this.store.persistStatus(slug, entry, "connected");
		await this.lifecycle.emitStatusBroadcast(slug, "connected");
		await this.lifecycle.emitToolsBroadcast(slug, result.toolNames);
		return { tools: result.toolNames };
	}

	private async handleList(_params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.store.requireKv(EXT_MCP_LIST);
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
		const kv = this.store.requireKv(EXT_MCP_INCLUDE);
		const slug = requireStringParam(EXT_MCP_INCLUDE, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_INCLUDE, params);
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_INCLUDE}: unknown mcp ${slug}`);
		this.registry.addInclusion(sessionId, slug);
		await this.store.persistInclusion(sessionId, this.registry.getInclusion(sessionId));
		return { slug, tools: this.provider.isConnected(slug) ? (this.provider.getToolNames(slug) ?? []) : [] };
	}

	private async handleExclude(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const slug = requireStringParam(EXT_MCP_EXCLUDE, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_EXCLUDE, params);
		this.registry.removeInclusion(sessionId, slug);
		await this.store.persistInclusion(sessionId, this.registry.getInclusion(sessionId));
		return { slug };
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
