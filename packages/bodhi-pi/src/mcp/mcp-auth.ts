import type { McpAuthConfig, McpNamedSecret } from "./mcp-types.js";

export interface ResolvedHttpAuth {
	headers: Record<string, string>;
	queryParams: Record<string, string>;
}

export function resolveHttpAuth(auth: McpAuthConfig): ResolvedHttpAuth {
	const headers: Record<string, string> = {};
	const queryParams: Record<string, string> = {};
	if (auth.headers) {
		for (const h of auth.headers) headers[h.name] = h.value;
	}
	if (auth.queryParams) {
		for (const q of auth.queryParams) queryParams[q.name] = q.value;
	}
	if ((auth.mode === "oauth-dcr" || auth.mode === "oauth-preregistered") && auth.tokens) {
		headers["Authorization"] = `Bearer ${auth.tokens.access.value}`;
	}
	return { headers, queryParams };
}

export function resolveStdioEnv(env: McpNamedSecret[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (env) for (const e of env) out[e.name] = e.value;
	return out;
}

export function applyQueryParams(url: string, params: Record<string, string>): string {
	const keys = Object.keys(params);
	if (keys.length === 0) return url;
	const u = new URL(url);
	for (const k of keys) u.searchParams.set(k, params[k]);
	return u.toString();
}
