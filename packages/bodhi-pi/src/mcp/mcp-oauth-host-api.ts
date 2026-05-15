import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { JsonValue, KvStore } from "../kv/kv-store.js";
import { BODHI_PI_VERSION } from "../version.js";
import { MCP_PREFIX, type McpServerEntry, parseMcpServerEntry, serializeMcpServerEntry } from "./mcp-types.js";

interface PendingFlow {
	authorizeUrl?: URL;
	codeVerifier?: string;
}

export interface KvOAuthProviderOptions {
	kvStore: KvStore;
	slug: string;
	redirectUrl: string;
	clientName?: string;
	scope?: string;
}

export class KvOAuthProvider implements OAuthClientProvider {
	private readonly opts: KvOAuthProviderOptions;
	private pending: PendingFlow = {};

	constructor(opts: KvOAuthProviderOptions) {
		this.opts = opts;
	}

	get redirectUrl(): string {
		return this.opts.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		const md: OAuthClientMetadata = {
			redirect_uris: [this.opts.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			client_name: this.opts.clientName ?? `bodhi-pi (${this.opts.slug})`,
		};
		if (this.opts.scope) md.scope = this.opts.scope;
		return md;
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		const entry = await this.readEntry();
		if (!entry?.auth.clientId) return undefined;
		const info: OAuthClientInformationMixed = { client_id: entry.auth.clientId };
		if (entry.auth.clientSecret) info.client_secret = entry.auth.clientSecret.value;
		return info;
	}

	async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
		await this.mutate((entry) => {
			entry.auth.clientId = info.client_id;
			if (info.client_secret) entry.auth.clientSecret = { value: info.client_secret, secret: true };
		});
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		const entry = await this.readEntry();
		if (!entry?.auth.tokens) return undefined;
		const out: OAuthTokens = {
			access_token: entry.auth.tokens.access.value,
			token_type: "Bearer",
		};
		if (entry.auth.tokens.refresh) out.refresh_token = entry.auth.tokens.refresh.value;
		if (entry.auth.tokens.expiresAt !== undefined) {
			const remaining = Math.max(0, Math.floor((entry.auth.tokens.expiresAt - Date.now()) / 1000));
			out.expires_in = remaining;
		}
		return out;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.mutate((entry) => {
			const tokensField: McpServerEntry["auth"]["tokens"] = {
				access: { value: tokens.access_token, secret: true },
			};
			if (tokens.refresh_token) tokensField.refresh = { value: tokens.refresh_token, secret: true };
			if (typeof tokens.expires_in === "number") {
				tokensField.expiresAt = Date.now() + tokens.expires_in * 1000;
			}
			entry.auth.tokens = tokensField;
		});
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		this.pending.authorizeUrl = url;
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		this.pending.codeVerifier = codeVerifier;
	}

	async codeVerifier(): Promise<string> {
		const v = this.pending.codeVerifier;
		if (!v) throw new Error(`KvOAuthProvider: no codeVerifier captured for ${this.opts.slug}`);
		return v;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		await this.mutate((entry) => {
			if (scope === "all" || scope === "tokens") delete entry.auth.tokens;
			if (scope === "all" || scope === "client") {
				delete entry.auth.clientId;
				delete entry.auth.clientSecret;
			}
		});
		if (scope === "all" || scope === "verifier") this.pending.codeVerifier = undefined;
	}

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

export async function runAuthFlow(
	provider: KvOAuthProvider,
	serverUrl: string,
	authorizationCode?: string,
): Promise<{ authorizeUrl?: string; authorized: boolean }> {
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

export const DEFAULT_OAUTH_CLIENT_NAME = `bodhi-pi/${BODHI_PI_VERSION}`;
