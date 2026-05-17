import type { JsonValue } from "../kv/kv-store.js";

/** KV-key namespace prefix for persisted MCP server entries: `mcp/<slug>`. */
export const MCP_PREFIX = "mcp/";

export type McpTransport = "http" | "stdio";

/**
 * Top-level auth discriminator. `"public"` carries no credentials. `"http-param"` attaches
 * static headers and/or query parameters to every request against an HTTP-streamable MCP server.
 * Future auth modes (e.g. `"oauth-dcr"`, `"oauth-preregistered"`) will extend this union with
 * their own additional fields on `McpAuthConfig`.
 */
export type McpAuthMode = "public" | "http-param";

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

export type McpAuthConfig = McpAuthPublicConfig | McpAuthHttpParamConfig;

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
	const out: { [k: string]: JsonValue } = { mode: "http-param" };
	if (auth.headers !== undefined && auth.headers.length > 0) {
		out.headers = auth.headers.map(serializeNamedSecret);
	}
	if (auth.queries !== undefined && auth.queries.length > 0) {
		out.queries = auth.queries.map(serializeNamedSecret);
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
	return null;
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
