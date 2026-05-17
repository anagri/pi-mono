import type { JsonValue, KvStore } from "../kv/kv-store.js";

export const OAUTH_STATE_PREFIX = "mcp/oauth-state/";

/** Default time-to-live for a pending OAuth flow (5 minutes — RFC 6749 §10.12 spirit). */
export const OAUTH_STATE_DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface OAuthStateEntry {
	slug: string;
	codeVerifier: string;
	redirectUri: string;
	expiresAt: number;
}

/**
 * Short-TTL wrapper over the host's `KvStore`. Keyed by the OAuth `state` parameter so the
 * HTTP `/oauth/callback` route can route a redirect back to the right `slug` + `codeVerifier`
 * without holding any in-memory state. The state token doubles as a CSRF guard.
 */
export class OAuthStateKv {
	constructor(
		private readonly kv: KvStore,
		private readonly now: () => number = () => Date.now(),
	) {}

	private key(state: string): string {
		return `${OAUTH_STATE_PREFIX}${state}`;
	}

	async set(
		state: string,
		entry: Omit<OAuthStateEntry, "expiresAt">,
		ttlMs = OAUTH_STATE_DEFAULT_TTL_MS,
	): Promise<void> {
		const value: OAuthStateEntry = { ...entry, expiresAt: this.now() + ttlMs };
		await this.kv.set(this.key(state), value as unknown as JsonValue);
		// Opportunistic eviction so long-running hosts don't grow unbounded.
		await this.pruneExpired();
	}

	async get(state: string): Promise<OAuthStateEntry | null> {
		const raw = await this.kv.get(this.key(state));
		const parsed = parseStateEntry(raw);
		if (!parsed) return null;
		if (this.now() > parsed.expiresAt) {
			await this.kv.remove(this.key(state));
			return null;
		}
		return parsed;
	}

	async remove(state: string): Promise<void> {
		await this.kv.remove(this.key(state));
	}

	private async pruneExpired(): Promise<void> {
		const SCAN_LIMIT = 100;
		const rows = (await this.kv.list(OAUTH_STATE_PREFIX)).slice(0, SCAN_LIMIT);
		const now = this.now();
		for (const row of rows) {
			const parsed = parseStateEntry(row.value);
			if (parsed && now > parsed.expiresAt) await this.kv.remove(row.key);
		}
	}
}

function parseStateEntry(value: JsonValue | null | undefined): OAuthStateEntry | null {
	if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
	const o = value as { [k: string]: JsonValue };
	if (typeof o.slug !== "string" || typeof o.codeVerifier !== "string" || typeof o.redirectUri !== "string")
		return null;
	if (typeof o.expiresAt !== "number") return null;
	return {
		slug: o.slug,
		codeVerifier: o.codeVerifier,
		redirectUri: o.redirectUri,
		expiresAt: o.expiresAt,
	};
}
