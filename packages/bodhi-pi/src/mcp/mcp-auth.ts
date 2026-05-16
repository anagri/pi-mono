import type { McpNamedSecret } from "./mcp-types.js";

export function resolveStdioEnv(env: McpNamedSecret[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (env) for (const e of env) out[e.name] = e.value;
	return out;
}
