import type { JsonValue } from "../kv/kv-store.js";

export const MCP_PREFIX = "mcp/";

export type McpTransport = "http" | "stdio";

export type McpAuthMode = "public" | "header" | "query" | "oauth-dcr" | "oauth-preregistered";

export type McpStatus = "connected" | "disconnected" | "error";

export interface SecretValue {
	value: string;
	secret: true;
}

export interface McpNamedValue {
	name: string;
	value: string;
}

export interface McpNamedSecret {
	name: string;
	value: string;
	secret: true;
}

export interface McpOAuthTokens {
	access: SecretValue;
	refresh?: SecretValue;
	expiresAt?: number;
}

export interface McpAuthConfig {
	mode: McpAuthMode;
	headers?: McpNamedSecret[];
	queryParams?: McpNamedSecret[];
	clientId?: string;
	clientSecret?: SecretValue;
	tokens?: McpOAuthTokens;
}

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
	const auth = parseAuthConfig(obj.auth);
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

function parseAuthConfig(value: JsonValue | undefined): McpAuthConfig | null {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as { [k: string]: JsonValue };
	const mode = obj.mode;
	if (
		mode !== "public" &&
		mode !== "header" &&
		mode !== "query" &&
		mode !== "oauth-dcr" &&
		mode !== "oauth-preregistered"
	) {
		return null;
	}
	const auth: McpAuthConfig = { mode };
	const headers = parseNamedSecretArray(obj.headers);
	if (headers !== null) auth.headers = headers;
	const queryParams = parseNamedSecretArray(obj.queryParams);
	if (queryParams !== null) auth.queryParams = queryParams;
	if (typeof obj.clientId === "string") auth.clientId = obj.clientId;
	const clientSecret = parseSecretValue(obj.clientSecret);
	if (clientSecret !== null) auth.clientSecret = clientSecret;
	const tokens = parseTokens(obj.tokens);
	if (tokens !== null) auth.tokens = tokens;
	return auth;
}

function serializeAuthConfig(auth: McpAuthConfig): JsonValue {
	const out: { [k: string]: JsonValue } = { mode: auth.mode };
	if (auth.headers !== undefined) out.headers = auth.headers.map(serializeNamedSecret);
	if (auth.queryParams !== undefined) out.queryParams = auth.queryParams.map(serializeNamedSecret);
	if (auth.clientId !== undefined) out.clientId = auth.clientId;
	if (auth.clientSecret !== undefined) out.clientSecret = serializeSecretValue(auth.clientSecret);
	if (auth.tokens !== undefined) {
		const t: { [k: string]: JsonValue } = { access: serializeSecretValue(auth.tokens.access) };
		if (auth.tokens.refresh !== undefined) t.refresh = serializeSecretValue(auth.tokens.refresh);
		if (auth.tokens.expiresAt !== undefined) t.expiresAt = auth.tokens.expiresAt;
		out.tokens = t;
	}
	return out;
}

function parseSecretValue(value: JsonValue | undefined): SecretValue | null {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as { [k: string]: JsonValue };
	if (typeof obj.value !== "string" || obj.secret !== true) return null;
	return { value: obj.value, secret: true };
}

function serializeSecretValue(v: SecretValue): JsonValue {
	return { value: v.value, secret: true };
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

function parseTokens(value: JsonValue | undefined): McpOAuthTokens | null {
	if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as { [k: string]: JsonValue };
	const access = parseSecretValue(obj.access);
	if (access === null) return null;
	const tokens: McpOAuthTokens = { access };
	const refresh = parseSecretValue(obj.refresh);
	if (refresh !== null) tokens.refresh = refresh;
	if (typeof obj.expiresAt === "number") tokens.expiresAt = obj.expiresAt;
	return tokens;
}
