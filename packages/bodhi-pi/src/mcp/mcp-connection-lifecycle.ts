import type { McpServer } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { BodhiPiLogger } from "../acp/agent.js";
import type { EventDispatcher } from "../events/dispatcher.js";
import type { SessionState } from "../sessions/session-state.js";
import type { McpConnectionProvider } from "./mcp-connection-provider.js";
import type { McpRegistry } from "./mcp-registry.js";
import { sanitizeSlug } from "./mcp-slug.js";
import type { McpStore } from "./mcp-store.js";
import type { McpServerEntry } from "./mcp-types.js";

export interface McpConnectionLifecycleDeps {
	events: EventDispatcher;
	sessions: Map<string, SessionState>;
	provider: McpConnectionProvider;
	logger: BodhiPiLogger;
	store: McpStore;
	registry: McpRegistry;
}

/**
 * Connection lifecycle (hydrate, connect/disconnect/reconnect retries) + status broadcasts.
 *
 * Status events are emitted to the `EventDispatcher` only — `src/acp/event-wiring.ts`
 * translates them into `LIFECYCLE_EVENT_METHOD` wire notifications. Do NOT add a direct
 * `conn.notification` call here; the single-mapping policy keeps SDK extraction tractable.
 */
export class McpConnectionLifecycle {
	private readonly events: EventDispatcher;
	private readonly sessions: Map<string, SessionState>;
	private readonly provider: McpConnectionProvider;
	private readonly logger: BodhiPiLogger;
	private readonly store: McpStore;
	private readonly registry: McpRegistry;

	constructor(deps: McpConnectionLifecycleDeps) {
		this.events = deps.events;
		this.sessions = deps.sessions;
		this.provider = deps.provider;
		this.logger = deps.logger;
		this.store = deps.store;
		this.registry = deps.registry;
	}

	/**
	 * Set the session's inclusion based on `ephemeral` and the session-stored `restoredSlugs`. Precedence:
	 *   `ephemeral === undefined` → restoredSlugs (session-stored wins; no new entry written)
	 *   `ephemeral === []`        → empty (writes new snapshot entry only if there was a prior non-empty inclusion)
	 *   `ephemeral === [A, B...]` → connect+include named slugs that exist in kv (writes new snapshot entry).
	 *                                Unknown slugs are dropped and reported via the returned `notFoundSlugs` array
	 *                                plus a per-slug `mcp_status_change{status:"error", errorMessage:"unknown slug"}`
	 *                                event so Hosts/Clients can surface the dropping.
	 */
	async hydrate(
		sessionId: string,
		ephemeral: McpServer[] | undefined,
		restoredSlugs: string[] | null,
	): Promise<{ notFoundSlugs: string[] }> {
		if (ephemeral === undefined) {
			this.registry.setInclusion(sessionId, restoredSlugs ?? []);
			return { notFoundSlugs: [] };
		}

		if (ephemeral.length === 0) {
			this.registry.setInclusion(sessionId, []);
			if (restoredSlugs && restoredSlugs.length > 0) {
				await this.store.persistInclusion(sessionId, []);
			}
			return { notFoundSlugs: [] };
		}

		const persisted = await this.store.loadPersistedEntries();
		const persistedBySlug = new Map(persisted.map((p) => [p.slug, p.entry] as const));
		const referenced: string[] = [];
		const notFoundSlugs: string[] = [];
		for (const s of ephemeral) {
			const slug = sanitizeSlug(s.name);
			const entry = persistedBySlug.get(slug);
			if (!entry) {
				notFoundSlugs.push(slug);
				await this.emitStatusForSession(sessionId, slug, "error", "unknown slug");
				continue;
			}
			referenced.push(slug);
			if (!this.provider.isConnected(slug)) {
				try {
					await this.provider.connect(slug, entry);
					await this.store.persistStatus(slug, entry, "connected");
				} catch {
					// best-effort; surface via mcp_status_change below
				}
			}
		}
		this.registry.setInclusion(sessionId, referenced);
		await this.store.persistInclusion(sessionId, referenced);
		return { notFoundSlugs };
	}

	private async emitStatusForSession(
		sessionId: string,
		slug: string,
		status: "connected" | "disconnected" | "error",
		errorMessage?: string,
	): Promise<void> {
		const payload: Record<string, unknown> = { type: "mcp_status_change", sessionId, slug, status };
		if (errorMessage !== undefined) payload.errorMessage = errorMessage;
		await this.events.emit(payload as never);
	}

	closeSession(sessionId: string): void {
		this.registry.clearInclusion(sessionId);
	}

	async tryProviderConnect(slug: string, entry: McpServerEntry): Promise<{ toolNames: string[] }> {
		try {
			return await this.provider.connect(slug, entry);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error(`[bodhi-pi mcp] connect ${slug} failed:`, message);
			await this.emitStatusBroadcast(slug, "error", message);
			throw new RequestError(-32603, `mcp/${slug}: ${message}`);
		}
	}

	async tryProviderReconnect(slug: string, entry: McpServerEntry): Promise<{ toolNames: string[] }> {
		try {
			return await this.provider.reconnect(slug, entry);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.error(`[bodhi-pi mcp] reconnect ${slug} failed:`, message);
			await this.emitStatusBroadcast(slug, "error", message);
			throw new RequestError(-32603, `mcp/${slug}: ${message}`);
		}
	}

	async emitStatusBroadcast(
		slug: string,
		status: "connected" | "disconnected" | "error",
		errorMessage?: string,
	): Promise<void> {
		if (this.sessions.size === 0) return;
		for (const sessionId of this.sessions.keys()) {
			const payload: Record<string, unknown> = { type: "mcp_status_change", sessionId, slug, status };
			if (errorMessage !== undefined) payload.errorMessage = errorMessage;
			await this.events.emit(payload as never);
		}
	}

	async emitToolsBroadcast(slug: string, toolNames: string[]): Promise<void> {
		if (this.sessions.size === 0) return;
		for (const sessionId of this.sessions.keys()) {
			const payload = { type: "mcp_tools_change" as const, sessionId, slug, toolNames };
			await this.events.emit(payload);
		}
	}

	async emitOauthStatusBroadcast(
		slug: string,
		status: "started" | "completed" | "failed" | "cancelled",
		errorMessage?: string,
	): Promise<void> {
		// OAuth status fires even when no session is loaded — long-flow callbacks may land between
		// session closes. Emit a sentinel sessionId "" so UI panels with no active session still see it.
		const targets = this.sessions.size === 0 ? [""] : Array.from(this.sessions.keys());
		for (const sessionId of targets) {
			const payload: Record<string, unknown> = { type: "mcp_oauth_status_change", sessionId, slug, status };
			if (errorMessage !== undefined) payload.errorMessage = errorMessage;
			await this.events.emit(payload as never);
		}
	}
}
