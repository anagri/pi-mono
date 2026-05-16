/** Result of parsing `/mcp add` slash arguments. */
export interface ParsedMcpAdd {
	url?: string;
	command?: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	label?: string;
	error?: string;
}

/**
 * Parse `key=value` tokens from `/mcp add` into a structured form.
 *
 * Supported keys: `url=`, `command=`, `args=` (JSON string[] or whitespace-split), `label=`,
 * `env_<NAME>=<value>` (stdio env vars). Quoted literals (`key="..."`) strip the quotes.
 */
export function parseMcpAddArgs(rest: string[]): ParsedMcpAdd {
	const out: ParsedMcpAdd = {};
	for (const tok of rest) {
		const m = /^([a-zA-Z_][\w-]*)=(.*)$/.exec(tok);
		if (!m) continue;
		const key = m[1] as string;
		const raw = m[2] as string;
		const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
		if (key === "url") out.url = value;
		else if (key === "command") out.command = value;
		else if (key === "label") out.label = value;
		else if (key === "args") {
			try {
				const parsed = JSON.parse(value);
				if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) out.args = parsed as string[];
				else out.error = "args must be a JSON string[]";
			} catch {
				out.args = value.split(/\s+/).filter((s) => s.length > 0);
			}
		} else if (key.startsWith("env_")) {
			out.env = out.env ?? [];
			out.env.push({ name: key.slice("env_".length), value });
		}
	}
	if (!out.url && !out.command) out.error = "expected url=<url> or command=<cmd>";
	return out;
}
