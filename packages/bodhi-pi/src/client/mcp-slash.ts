/** Result of parsing `/mcp add` slash arguments — the parsed JSON object, or an error. */
export interface ParsedMcpAdd {
	/** Parsed JSON object (already validated as a plain object, not array/primitive). */
	value?: Record<string, unknown>;
	error?: string;
}

/**
 * Parse `/mcp add <json-object>` into the JSON-object body sent to `_bodhi-pi/mcp/add`.
 *
 * The slash takes exactly one argument: a JSON object. The Host's `McpService.handleAdd`
 * is the single validation surface for field shape (`url`, `command`, `auth`, `headers`,
 * `queries`, `args`, `env`, `label`). This parser only checks "is it a JSON object."
 *
 * Examples:
 *   /mcp add {"url":"https://example/mcp","auth":"public"}
 *   /mcp add {"url":"https://example/mcp","auth":"http-param","headers":{"Authorization":"Bearer X"}}
 *   /mcp add {"command":"npx","args":["-y","server-everything","stdio"]}
 */
export function parseMcpAddArgs(rest: string[]): ParsedMcpAdd {
	const joined = rest.join(" ").trim();
	if (joined.length === 0) {
		return { error: "/mcp add expects one JSON object argument" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(joined);
	} catch (e) {
		return { error: `/mcp add: invalid JSON (${(e as Error).message})` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: "/mcp add: argument must be a JSON object" };
	}
	return { value: parsed as Record<string, unknown> };
}
