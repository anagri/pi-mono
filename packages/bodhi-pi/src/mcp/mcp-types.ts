import type { JsonValue } from "../kv/kv-store.js";

/** KV-key namespace prefix for persisted MCP server entries: `mcp/<slug>`. */
export const MCP_PREFIX = "mcp/";

export type McpTransport = "http" | "stdio";

/**
 * Top-level auth discriminator. `"public"` carries no credentials. `"http-param"` attaches
 * static headers and/or query parameters to every request against an HTTP-streamable MCP server.
 * `"oauth-preregistered"` runs the OAuth 2.1 authorization-code-with-PKCE flow using
 * pre-registered `client_id` / `client_secret`; no DCR, no RFC 8414 discovery.
 */
export type McpAuthMode = "public" | "http-param" | "oauth-preregistered";

export type McpStatus = "connected" | "disconnected" | "error";

export interface McpNamedSecret {
	name: string;
	value: string;
	secret: true;
}

export interface McpAuthPublicConfig {
	mode: "public";
}

export interface McpAuthHttpParamConfig {
	mode: "http-param";
	headers?: McpNamedSecret[];
	queries?: McpNamedSecret[];
}

export interface McpOAuthTokens {
	access: McpNamedSecret;
	refresh?: McpNamedSecret;
	expiresAt?: number;
	tokenType?: string;
}

export interface McpAuthOAuthPreregisteredConfig {
	mode: "oauth-preregistered";
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret?: McpNamedSecret;
	scopes?: string[];
	redirectUri?: string;
	tokenAuthMethod?: "basic" | "post";
	tokens?: McpOAuthTokens;
}

export type McpAuthConfig = McpAuthPublicConfig | McpAuthHttpParamConfig | McpAuthOAuthPreregisteredConfig;

export interface McpServerEntry {
	transport: McpTransport;
	url?: string;
	command?: string;
	args?: string[];
	env?: McpNamedSecret[];
	auth: McpAuthConfig;
	lastKnownStatus: McpStatus;
	addedAt: string;
	label: string;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: JsonValue;
}

export interface McpListEntry {
	slug: string;
	label: string;
	transport: McpTransport;
	status: McpStatus;
	url?: string;
	command?: string;
	auth: JsonValue;
	error?: string;
}

export function parseMcpServerEntry(value: JsonValue | null | undefined): McpServerEntry | null {
	if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as { [k: string]: JsonValue };
	const transport = obj.transport;
	if (transport !== "http" && transport !== "stdio") return null;
	const label = typeof obj.label === "string" ? obj.label : null;
	const addedAt = typeof obj.addedAt === "string" ? obj.addedAt : null;
	const lastKnownStatus = obj.lastKnownStatus;
	if (
		label === null ||
		addedAt === null ||
		(lastKnownStatus !== "connected" && lastKnownStatus !== "disconnected" && lastKnownStatus !== "error")
	) {
		return null;
	}
	const auth = parseAuthConfigStored(obj.auth);
	if (auth === null) return null;
	const entry: McpServerEntry = {
		transport,
		auth,
		label,
		addedAt,
		lastKnownStatus,
	};
	if (typeof obj.url === "string") entry.url = obj.url;
	if (typeof obj.command === "string") entry.command = obj.command;
	const args = obj.args;
	if (Array.isArray(args) && args.every((a) => typeof a === "string")) entry.args = args as string[];
	const env = parseNamedSecretArray(obj.env);
	if (env !== null) entry.env = env;
	if (transport === "http" && entry.url === undefined) return null;
	if (transport === "stdio" && entry.command === undefined) return null;
	return entry;
}

export function serializeMcpServerEntry(entry: McpServerEntry): JsonValue {
	const out: { [k: string]: JsonValue } = {
		transport: entry.transport,
		auth: serializeAuthConfig(entry.auth),
		label: entry.label,
		addedAt: entry.addedAt,
		lastKnownStatus: entry.lastKnownStatus,
	};
	if (entry.url !== undefined) out.url = entry.url;
	if (entry.command !== undefined) out.command = entry.command;
	if (entry.args !== undefined) out.args = [...entry.args];
	if (entry.env !== undefined) out.env = entry.env.map(serializeNamedSecret);
	return out;
}

export function serializeAuthConfig(auth: McpAuthConfig): JsonValue {
	if (auth.mode === "public") return { mode: "public" };
	if (auth.mode === "http-param") {
		const out: { [k: string]: JsonValue } = { mode: "http-param" };
		if (auth.headers !== undefined && auth.headers.length > 0) {
			out.headers = auth.headers.map(serializeNamedSecret);
		}
		if (auth.queries !== undefined && auth.queries.length > 0) {
			out.queries = auth.queries.map(serializeNamedSecret);
		}
		return out;
	}
	const out: { [k: string]: JsonValue } = {
		mode: "oauth-preregistered",
		authorizeUrl: auth.authorizeUrl,
		tokenUrl: auth.tokenUrl,
		clientId: auth.clientId,
	};
	if (auth.clientSecret !== undefined) out.clientSecret = serializeNamedSecret(auth.clientSecret);
	if (auth.scopes !== undefined && auth.scopes.length > 0) out.scopes = [...auth.scopes];
	if (auth.redirectUri !== undefined) out.redirectUri = auth.redirectUri;
	if (auth.tokenAuthMethod !== undefined) out.tokenAuthMethod = auth.tokenAuthMethod;
	if (auth.tokens !== undefined) {
		const t: { [k: string]: JsonValue } = { access: serializeNamedSecret(auth.tokens.access) };
		if (auth.tokens.refresh !== undefined) t.refresh = serializeNamedSecret(auth.tokens.refresh);
		if (auth.tokens.expiresAt !== undefined) t.expiresAt = auth.tokens.expiresAt;
		if (auth.tokens.tokenType !== undefined) t.tokenType = auth.tokens.tokenType;
		out.tokens = t;
	}
	return out;
}

function parseAuthConfigStored(value: JsonValue | undefined): McpAuthConfig | null {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as { [k: string]: JsonValue };
	if (obj.mode === "public") return { mode: "public" };
	if (obj.mode === "http-param") {
		const cfg: McpAuthHttpParamConfig = { mode: "http-param" };
		const headers = parseNamedSecretArray(obj.headers);
		if (headers !== null) cfg.headers = headers;
		const queries = parseNamedSecretArray(obj.queries);
		if (queries !== null) cfg.queries = queries;
		// A persisted http-param entry must carry at least one header or query —
		// otherwise it's indistinguishable from "public" and shouldn't exist on disk.
		if (
			(cfg.headers === undefined || cfg.headers.length === 0) &&
			(cfg.queries === undefined || cfg.queries.length === 0)
		) {
			return null;
		}
		return cfg;
	}
	if (obj.mode === "oauth-preregistered") {
		const authorizeUrl = obj.authorizeUrl;
		const tokenUrl = obj.tokenUrl;
		const clientId = obj.clientId;
		if (typeof authorizeUrl !== "string" || typeof tokenUrl !== "string" || typeof clientId !== "string") {
			return null;
		}
		const cfg: McpAuthOAuthPreregisteredConfig = {
			mode: "oauth-preregistered",
			authorizeUrl,
			tokenUrl,
			clientId,
		};
		const clientSecret = parseNamedSecret(obj.clientSecret);
		if (clientSecret !== null) cfg.clientSecret = clientSecret;
		if (Array.isArray(obj.scopes) && obj.scopes.every((s) => typeof s === "string")) {
			cfg.scopes = obj.scopes as string[];
		}
		if (typeof obj.redirectUri === "string") cfg.redirectUri = obj.redirectUri;
		if (obj.tokenAuthMethod === "basic" || obj.tokenAuthMethod === "post") {
			cfg.tokenAuthMethod = obj.tokenAuthMethod;
		}
		const tokens = parseOAuthTokens(obj.tokens);
		if (tokens !== null) cfg.tokens = tokens;
		return cfg;
	}
	return null;
}

function parseOAuthTokens(value: JsonValue | undefined): McpOAuthTokens | null {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as { [k: string]: JsonValue };
	const access = parseNamedSecret(obj.access);
	if (access === null) return null;
	const out: McpOAuthTokens = { access };
	const refresh = parseNamedSecret(obj.refresh);
	if (refresh !== null) out.refresh = refresh;
	if (typeof obj.expiresAt === "number") out.expiresAt = obj.expiresAt;
	if (typeof obj.tokenType === "string") out.tokenType = obj.tokenType;
	return out;
}

function parseNamedSecret(value: JsonValue | undefined): McpNamedSecret | null {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const o = value as { [k: string]: JsonValue };
	if (typeof o.name !== "string" || typeof o.value !== "string" || o.secret !== true) return null;
	return { name: o.name, value: o.value, secret: true };
}

function parseNamedSecretArray(value: JsonValue | undefined): McpNamedSecret[] | null {
	if (!Array.isArray(value)) return null;
	const out: McpNamedSecret[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
		const o = item as { [k: string]: JsonValue };
		if (typeof o.name !== "string" || typeof o.value !== "string" || o.secret !== true) return null;
		out.push({ name: o.name, value: o.value, secret: true });
	}
	return out;
}

function serializeNamedSecret(s: McpNamedSecret): JsonValue {
	return { name: s.name, value: s.value, secret: true };
}
