import type { AgentSideConnection, McpServer } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { BodhiPiLogger } from "../acp/agent.js";
import type { EventDispatcher } from "../events/dispatcher.js";
import type { JsonValue, KvStore } from "../kv/kv-store.js";
import { maskSecrets } from "../kv/kv-store.js";
import type { SessionState } from "../sessions/session-state.js";
import {
	EXT_MCP_ADD,
	EXT_MCP_CONNECT,
	EXT_MCP_DISCONNECT,
	EXT_MCP_LIST,
	EXT_MCP_OAUTH_FINISH,
	EXT_MCP_OAUTH_START,
	EXT_MCP_RECONNECT,
	EXT_MCP_REMOVE,
	EXT_MCP_TOOLS,
	LIFECYCLE_EVENT_METHOD,
} from "../wire/constants.js";
import { optionalSessionId, requireStringParam, validateSessionId } from "../wire/validators.js";
import { type ConnectedClient, connectMcp } from "./mcp-client.js";
import { KvOAuthProvider, runAuthFlow } from "./mcp-oauth-host-api.js";
import { McpRegistry } from "./mcp-registry.js";
import { resolveUniqueSlug, slugifyCommand, slugifyUrl } from "./mcp-slug.js";
import { toolName } from "./mcp-tool-adapter.js";
import {
	MCP_PREFIX,
	type McpAuthConfig,
	type McpAuthMode,
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
	/**
	 * Capability gate. Hosts that can't spawn child processes (browser, chrome-ext, stateless http)
	 * pass `false` here so `_bodhi-pi/mcp/add` rejects `command=…` cleanly.
	 */
	supportsStdio?: boolean;
}

export class McpService {
	private readonly registry: McpRegistry;
	private readonly kvStore: KvStore | undefined;
	private readonly events: EventDispatcher;
	private readonly conn: AgentSideConnection;
	private readonly logger: BodhiPiLogger;
	private readonly supportsStdio: boolean;
	private readonly sessions: Map<string, SessionState>;

	constructor(deps: McpServiceDeps) {
		this.kvStore = deps.kvStore;
		this.events = deps.events;
		this.conn = deps.conn;
		this.logger = deps.logger;
		this.sessions = deps.sessions;
		this.supportsStdio = deps.supportsStdio ?? true;
		this.registry = new McpRegistry(deps.sessions);
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
			[EXT_MCP_OAUTH_START, this.handleOAuthStart.bind(this)],
			[EXT_MCP_OAUTH_FINISH, this.handleOAuthFinish.bind(this)],
		];
	}

	/**
	 * Hydrate MCP connections for a freshly bootstrapped session. Reads kv `mcp/*` entries
	 * with `lastKnownStatus === "connected"`, merges with any ACP-native `mcpServers` from
	 * the session-init params, connects in parallel. Failures non-fatal: per-server status
	 * emitted via `mcp_status_change` events.
	 */
	async hydrate(sessionId: string, ephemeral: McpServer[] | undefined): Promise<void> {
		const persisted = await this.loadPersistedEntries();
		const persistedEntries = persisted.filter(({ entry }) => entry.lastKnownStatus === "connected");
		const ephemeralEntries = (ephemeral ?? []).flatMap((s) => {
			const entry = fromAcpMcpServer(s);
			return entry ? [{ slug: sanitizeSlugForAcp(s.name), entry }] : [];
		});
		const all = [...persistedEntries, ...ephemeralEntries];
		await Promise.all(all.map((p) => this.connectOne(sessionId, p.slug, p.entry).catch(() => undefined)));
	}

	/** Tear down all MCP clients for a session. Called on session/close and session/delete. */
	async closeSession(sessionId: string): Promise<void> {
		await this.registry.closeSession(sessionId);
	}

	// ------------- extension handlers -------------

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
		const auth = parseAuthParam(params.auth);
		const label = typeof params.label === "string" && params.label.length > 0 ? params.label : undefined;
		const candidate = transport === "http" ? slugifyUrl(url ?? "") : slugifyCommand(command ?? "", args);
		const slug = await resolveUniqueSlug(candidate, kv);
		const entry: McpServerEntry = {
			transport,
			auth,
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
		const sessionId = optionalSessionId(params);
		if (sessionId !== undefined) {
			await this.registry.remove(sessionId, slug);
		} else {
			for (const sid of this.sessions.keys()) {
				if (this.registry.has(sid, slug)) await this.registry.remove(sid, slug);
			}
		}
		await kv.remove(`${MCP_PREFIX}${slug}`);
		return { slug };
	}

	private async handleConnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_CONNECT);
		const slug = requireStringParam(EXT_MCP_CONNECT, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_CONNECT, params);
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_CONNECT}: unknown mcp ${slug}`);
		if (this.registry.has(sessionId, slug)) {
			return { tools: namesFor(slug, this.registry.getToolInfos(sessionId, slug)) };
		}
		const tools = await this.connectOne(sessionId, slug, entry);
		await this.persistStatus(slug, entry, "connected");
		return { tools };
	}

	private async handleDisconnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_DISCONNECT);
		const slug = requireStringParam(EXT_MCP_DISCONNECT, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_DISCONNECT, params);
		await this.registry.remove(sessionId, slug);
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (entry) await this.persistStatus(slug, entry, "disconnected");
		await this.emitStatus(sessionId, slug, "disconnected");
		return { slug };
	}

	private async handleReconnect(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		await this.handleDisconnect(params);
		return this.handleConnect(params);
	}

	private async handleList(_params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_LIST);
		const entries = await kv.list(MCP_PREFIX);
		const out: McpListEntry[] = [];
		for (const e of entries) {
			const entry = parseMcpServerEntry(e.value);
			if (!entry) continue;
			const slug = e.key.slice(MCP_PREFIX.length);
			const item: McpListEntry = {
				slug,
				label: entry.label,
				transport: entry.transport,
				status: entry.lastKnownStatus,
			};
			if (entry.url !== undefined) item.url = entry.url;
			if (entry.command !== undefined) item.command = entry.command;
			out.push(item);
		}
		// Cast through unknown to keep the typed shape for the client without bare `unknown` indexes.
		return { entries: out as unknown as Record<string, unknown>[] };
	}

	private async handleTools(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const slug = requireStringParam(EXT_MCP_TOOLS, params, "slug");
		const sessionId = validateSessionId(EXT_MCP_TOOLS, params);
		const infos = this.registry.getToolInfos(sessionId, slug);
		return { tools: namesFor(slug, infos) };
	}

	private async handleOAuthStart(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_OAUTH_START);
		const slug = requireStringParam(EXT_MCP_OAUTH_START, params, "slug");
		const redirectUri = requireStringParam(EXT_MCP_OAUTH_START, params, "redirectUri");
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_OAUTH_START}: unknown mcp ${slug}`);
		if (entry.transport !== "http" || !entry.url) {
			throw new RequestError(-32602, `${EXT_MCP_OAUTH_START}: oauth requires http transport with a url`);
		}
		const provider = new KvOAuthProvider({ kvStore: kv, slug, redirectUrl: redirectUri });
		const { authorizeUrl, authorized } = await runAuthFlow(provider, entry.url);
		if (authorized) return { authorized: true };
		if (!authorizeUrl) {
			throw new RequestError(-32603, `${EXT_MCP_OAUTH_START}: provider did not produce an authorize URL`);
		}
		return { authorized: false, authorizeUrl };
	}

	private async handleOAuthFinish(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKv(EXT_MCP_OAUTH_FINISH);
		const slug = requireStringParam(EXT_MCP_OAUTH_FINISH, params, "slug");
		const code = requireStringParam(EXT_MCP_OAUTH_FINISH, params, "code");
		const redirectUri = requireStringParam(EXT_MCP_OAUTH_FINISH, params, "redirectUri");
		const sessionId = validateSessionId(EXT_MCP_OAUTH_FINISH, params);
		const raw = await kv.get(`${MCP_PREFIX}${slug}`);
		const entry = parseMcpServerEntry(raw ?? null);
		if (!entry) throw new RequestError(-32602, `${EXT_MCP_OAUTH_FINISH}: unknown mcp ${slug}`);
		if (entry.transport !== "http" || !entry.url) {
			throw new RequestError(-32602, `${EXT_MCP_OAUTH_FINISH}: oauth requires http transport with a url`);
		}
		const provider = new KvOAuthProvider({ kvStore: kv, slug, redirectUrl: redirectUri });
		const { authorized } = await runAuthFlow(provider, entry.url, code);
		if (!authorized) {
			throw new RequestError(-32603, `${EXT_MCP_OAUTH_FINISH}: token exchange did not authorize`);
		}
		// Tokens are now persisted; connect MCP and surface tools.
		const refreshed = parseMcpServerEntry((await kv.get(`${MCP_PREFIX}${slug}`)) ?? null);
		if (!refreshed) throw new RequestError(-32603, `${EXT_MCP_OAUTH_FINISH}: entry vanished after token save`);
		const tools = await this.connectOne(sessionId, slug, refreshed);
		await this.persistStatus(slug, refreshed, "connected");
		return { tools };
	}

	// ------------- internals -------------

	private async connectOne(sessionId: string, slug: string, entry: McpServerEntry): Promise<string[]> {
		let connected: ConnectedClient;
		try {
			connected = await connectMcp(entry);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error(`[bodhi-pi mcp] connect ${slug} failed:`, message);
			await this.emitStatus(sessionId, slug, "error", message);
			throw new RequestError(-32603, `mcp/${slug}: ${message}`);
		}
		this.registry.add(sessionId, slug, connected.client, connected.tools, connected.close);
		await this.emitStatus(sessionId, slug, "connected");
		await this.emitToolsChange(sessionId, slug, namesFor(slug, connected.tools));
		return namesFor(slug, connected.tools);
	}

	private async persistStatus(
		slug: string,
		entry: McpServerEntry,
		status: "connected" | "disconnected" | "error",
	): Promise<void> {
		const next = { ...entry, lastKnownStatus: status };
		await this.kvStore?.set(`${MCP_PREFIX}${slug}`, serializeMcpServerEntry(next));
	}

	private async emitStatus(
		sessionId: string,
		slug: string,
		status: "connected" | "disconnected" | "error",
		errorMessage?: string,
	): Promise<void> {
		await this.events.emit({
			type: "mcp_status_change",
			sessionId,
			slug,
			status,
			...(errorMessage !== undefined ? { errorMessage } : {}),
		});
		// Fire-and-forget lifecycle notification so the client can render status without polling.
		const params: Record<string, unknown> = {
			type: "mcp_status_change",
			sessionId,
			slug,
			status,
		};
		if (errorMessage !== undefined) params.errorMessage = errorMessage;
		// Best-effort; some hosts may not have a wired listener.
		await this.notifyLifecycle(params);
	}

	private async emitToolsChange(sessionId: string, slug: string, toolNames: string[]): Promise<void> {
		await this.events.emit({ type: "mcp_tools_change", sessionId, slug, toolNames });
		await this.notifyLifecycle({ type: "mcp_tools_change", sessionId, slug, toolNames });
	}

	private async notifyLifecycle(params: Record<string, unknown>): Promise<void> {
		try {
			// Notifications are addressed at the connection level.
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

function namesFor(slug: string, infos: { name: string }[]): string[] {
	return infos.map((i) => toolName(slug, i.name));
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

function parseAuthParam(value: unknown): McpAuthConfig {
	if (value === undefined || value === null) return { mode: "public" };
	if (typeof value !== "object" || Array.isArray(value)) return { mode: "public" };
	const obj = value as { [k: string]: unknown };
	const mode = obj.mode;
	const validMode: McpAuthMode =
		mode === "header" || mode === "query" || mode === "oauth-dcr" || mode === "oauth-preregistered" ? mode : "public";
	const out: McpAuthConfig = { mode: validMode };
	const headers = parseNamedSecretListParam(obj.headers);
	if (headers.length > 0) out.headers = headers;
	const queryParams = parseNamedSecretListParam(obj.queryParams);
	if (queryParams.length > 0) out.queryParams = queryParams;
	return out;
}

/** Convert an ACP `McpServer` into an internal `McpServerEntry` (no persistence). */
function fromAcpMcpServer(s: McpServer): McpServerEntry | null {
	const transport = (s as { type?: string }).type ?? ("command" in s ? "stdio" : undefined);
	if (transport === "http") {
		const http = s as { url: string; headers: Array<{ name: string; value: string }>; name: string };
		const headers: McpNamedSecret[] = (http.headers ?? []).map((h) => ({
			name: h.name,
			value: h.value,
			secret: true,
		}));
		return {
			transport: "http",
			url: http.url,
			auth: headers.length > 0 ? { mode: "header", headers } : { mode: "public" },
			label: http.name,
			addedAt: new Date().toISOString(),
			lastKnownStatus: "connected",
		};
	}
	if (transport === "stdio" || "command" in s) {
		const stdio = s as { command: string; args: string[]; env: Array<{ name: string; value: string }>; name: string };
		const env: McpNamedSecret[] = (stdio.env ?? []).map((e) => ({
			name: e.name,
			value: e.value,
			secret: true,
		}));
		return {
			transport: "stdio",
			command: stdio.command,
			args: stdio.args ?? [],
			...(env.length > 0 ? { env } : {}),
			auth: { mode: "public" },
			label: stdio.name,
			addedAt: new Date().toISOString(),
			lastKnownStatus: "connected",
		};
	}
	return null;
}

function sanitizeSlugForAcp(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "mcp"
	);
}

/** Re-exported for `kv-service`-style symmetry — masks an MCP entry for client-side reads. */
export function maskedEntry(value: JsonValue): JsonValue {
	return maskSecrets(value);
}
