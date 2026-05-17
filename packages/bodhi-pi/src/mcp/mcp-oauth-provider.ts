import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	AuthorizationServerMetadata,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { JsonValue, KvStore } from "../kv/kv-store.js";
import type { OAuthStateKv } from "./mcp-oauth-state-kv.js";
import {
	MCP_PREFIX,
	type McpAuthOAuthConfig,
	type McpServerEntry,
	parseMcpServerEntry,
	serializeMcpServerEntry,
} from "./mcp-types.js";

export interface KvOAuthProviderOptions {
	kvStore: KvStore;
	slug: string;
	cfg: McpAuthOAuthConfig;
	redirectUri: string;
	stateKv: OAuthStateKv;
	/** Pre-allocated state token for this flow; ties saveCodeVerifier writes to a stable key. */
	state: string;
}

interface PendingFlow {
	authorizeUrl?: URL;
}

/**
 * `OAuthClientProvider` wrapper that backs PKCE state with `OAuthStateKv` and token persistence
 * with the host's `KvStore` under the existing `mcp/<slug>` entry. Pre-populates `discoveryState()`
 * with the user-supplied `authorize_url` + `token_url` so the SDK's `auth()` driver skips RFC 8414
 * metadata discovery entirely — bodhi-pi's contract is "explicit URLs only."
 */
export class KvOAuthProvider implements OAuthClientProvider {
	private readonly opts: KvOAuthProviderOptions;
	private pending: PendingFlow = {};

	constructor(opts: KvOAuthProviderOptions) {
		this.opts = opts;
	}

	get redirectUrl(): string {
		return this.opts.redirectUri;
	}

	get clientMetadata(): OAuthClientMetadata {
		const md: OAuthClientMetadata = {
			redirect_uris: [this.opts.redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: this.opts.cfg.clientSecret
				? this.opts.cfg.tokenAuthMethod === "post"
					? "client_secret_post"
					: "client_secret_basic"
				: "none",
			client_name: `bodhi-pi (${this.opts.slug})`,
		};
		if (this.opts.cfg.scopes && this.opts.cfg.scopes.length > 0) {
			md.scope = this.opts.cfg.scopes.join(" ");
		}
		return md;
	}

	state(): string {
		return this.opts.state;
	}

	clientInformation(): OAuthClientInformationMixed {
		const info: OAuthClientInformationMixed = { client_id: this.opts.cfg.clientId };
		if (this.opts.cfg.clientSecret) info.client_secret = this.opts.cfg.clientSecret.value;
		return info;
	}

	// `saveClientInformation` deliberately omitted — pre-registered means no DCR. If the SDK
	// ever calls it on us, that's a bug we want to surface, not silently swallow.

	discoveryState(): {
		authorizationServerUrl: string;
		authorizationServerMetadata: AuthorizationServerMetadata;
	} {
		// Pre-populated so the SDK skips RFC 8414 / RFC 9728 discovery probes.
		return {
			authorizationServerUrl: this.opts.cfg.authorizeUrl,
			authorizationServerMetadata: {
				issuer: new URL(this.opts.cfg.authorizeUrl).origin,
				authorization_endpoint: this.opts.cfg.authorizeUrl,
				token_endpoint: this.opts.cfg.tokenUrl,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				grant_types_supported: ["authorization_code", "refresh_token"],
			},
		};
	}

	saveDiscoveryState(): void {
		// no-op — discoveryState is statically derived from cfg, no need to cache.
	}

	async validateResourceURL(): Promise<URL | undefined> {
		// Per the prompt's locked decisions: RFC 8707 resource indicators are NOT used in bodhi-pi.
		// Returning `undefined` here tells the SDK to omit the `resource` parameter from the token
		// request — without this override, the SDK fetches `/.well-known/oauth-protected-resource`
		// from `serverUrl` even when our `discoveryState` is cached, and rejects when the discovered
		// resource doesn't match `serverUrl` (the token endpoint, in our case).
		return undefined;
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		const entry = await this.readEntry();
		const persisted = entry?.auth.mode === "oauth" ? entry.auth.tokens : undefined;
		if (!persisted) return undefined;
		const out: OAuthTokens = {
			access_token: persisted.access.value,
			token_type: persisted.tokenType ?? "Bearer",
		};
		if (persisted.refresh) out.refresh_token = persisted.refresh.value;
		if (persisted.expiresAt !== undefined) {
			out.expires_in = Math.max(0, Math.floor((persisted.expiresAt - Date.now()) / 1000));
		}
		return out;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.mutate((entry) => {
			if (entry.auth.mode !== "oauth") return;
			const access = { name: "access", value: tokens.access_token, secret: true as const };
			const next: McpServerEntry["auth"] = {
				...entry.auth,
				tokens: {
					access,
					...(tokens.refresh_token
						? { refresh: { name: "refresh", value: tokens.refresh_token, secret: true as const } }
						: {}),
					...(typeof tokens.expires_in === "number" ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}),
					...(tokens.token_type ? { tokenType: tokens.token_type } : {}),
				},
			};
			entry.auth = next;
		});
	}

	redirectToAuthorization(url: URL): void {
		this.pending.authorizeUrl = url;
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.opts.stateKv.set(this.opts.state, {
			slug: this.opts.slug,
			codeVerifier,
			redirectUri: this.opts.redirectUri,
		});
	}

	async codeVerifier(): Promise<string> {
		const entry = await this.opts.stateKv.get(this.opts.state);
		if (!entry) {
			throw new Error(`KvOAuthProvider: no codeVerifier for state ${this.opts.state} (expired or unknown)`);
		}
		return entry.codeVerifier;
	}

	// `invalidateCredentials` deliberately omitted. Implementing it caused regressions: on a
	// transient refresh race (two parallel requests both racing to refresh the same token), the
	// SDK would invalidate stored tokens after the InvalidGrant error, deleting them from kv —
	// and every subsequent request would then send no Authorization header. Without this method
	// the SDK still retries auth(), but our persisted state stays intact, so the next request
	// reads valid tokens (the winning refresh's output) and succeeds. Re-auth after a real
	// server-side revocation goes through the interactive `_bodhi-pi/mcp/oauth/start` flow.

	getPendingAuthorizeUrl(): URL | undefined {
		return this.pending.authorizeUrl;
	}

	clearPending(): void {
		this.pending = {};
	}

	private async readEntry(): Promise<McpServerEntry | null> {
		const raw = (await this.opts.kvStore.get(`${MCP_PREFIX}${this.opts.slug}`)) ?? null;
		return parseMcpServerEntry(raw);
	}

	private async mutate(fn: (entry: McpServerEntry) => void): Promise<void> {
		const entry = await this.readEntry();
		if (!entry) throw new Error(`KvOAuthProvider: mcp/${this.opts.slug} missing`);
		fn(entry);
		await this.opts.kvStore.set(`${MCP_PREFIX}${this.opts.slug}`, serializeMcpServerEntry(entry) as JsonValue);
	}
}

export interface RunAuthFlowResult {
	authorizeUrl?: string;
	authorized: boolean;
}

/**
 * Drive the SDK's `auth()` orchestrator. If `authorizationCode` is omitted, the SDK either
 * refreshes from persisted tokens (returns `AUTHORIZED`) or generates a PKCE challenge and
 * captures the authorize URL via `provider.redirectToAuthorization`. If `authorizationCode` is
 * supplied, the SDK exchanges it for tokens and persists them via `provider.saveTokens`.
 */
export async function runAuthFlow(
	provider: KvOAuthProvider,
	serverUrl: string,
	authorizationCode?: string,
): Promise<RunAuthFlowResult> {
	provider.clearPending();
	const result = await auth(provider, {
		serverUrl,
		...(authorizationCode ? { authorizationCode } : {}),
	});
	if (result === "AUTHORIZED") return { authorized: true };
	const pending = provider.getPendingAuthorizeUrl();
	if (!pending) {
		throw new Error("OAuth flow expected authorize URL but provider did not capture one");
	}
	return { authorizeUrl: pending.toString(), authorized: false };
}
