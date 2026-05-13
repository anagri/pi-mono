import type { ProviderAuth } from "../client/types.js";

export interface SlashArgs {
	positionals: string[];
	kwargs: Record<string, string>;
}

/**
 * Parse a slash command's argument string into positionals and `key=value` kwargs.
 * Supports bareword values, double-quoted, and single-quoted values with embedded
 * spaces. Inside quotes, `\"` and `\'` escape the matching quote; other escapes are
 * passthrough. Unquoted values may not contain whitespace.
 *
 * Examples:
 *   parseSlashArgs("openai api_key=\"sk-1\" base_url=http://x")
 *     => { positionals: ["openai"], kwargs: { api_key: "sk-1", base_url: "http://x" } }
 *   parseSlashArgs("ollama")
 *     => { positionals: ["ollama"], kwargs: {} }
 *   parseSlashArgs("")
 *     => { positionals: [], kwargs: {} }
 */
export function parseSlashArgs(input: string): SlashArgs {
	const positionals: string[] = [];
	const kwargs: Record<string, string> = {};
	let i = 0;
	const s = input;
	while (i < s.length) {
		while (i < s.length && isSpace(s[i])) i++;
		if (i >= s.length) break;
		const tokenStart = i;
		let key: string | null = null;
		// Scan a bare key up to `=`, whitespace, or quote.
		while (i < s.length && !isSpace(s[i]) && s[i] !== "=" && s[i] !== '"' && s[i] !== "'") i++;
		const beforeEq = s.slice(tokenStart, i);
		if (i < s.length && s[i] === "=") {
			key = beforeEq;
			i++;
		}
		let value: string;
		if (i < s.length && (s[i] === '"' || s[i] === "'")) {
			const quote = s[i];
			i++;
			let v = "";
			while (i < s.length && s[i] !== quote) {
				if (s[i] === "\\" && i + 1 < s.length && s[i + 1] === quote) {
					v += quote;
					i += 2;
				} else {
					v += s[i];
					i++;
				}
			}
			if (i >= s.length) throw new Error(`unterminated ${quote === '"' ? "double" : "single"}-quoted value`);
			i++;
			value = v;
		} else {
			const valueStart = i;
			while (i < s.length && !isSpace(s[i])) i++;
			value = s.slice(valueStart, i);
		}
		if (key === null) {
			positionals.push(beforeEq);
		} else {
			if (!key) throw new Error("empty key in key=value pair");
			kwargs[key] = value;
		}
	}
	return { positionals, kwargs };
}

function isSpace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Known providers that accept a keyless `base_url` default. Used by `/login <provider>`
 * with no kwargs so hosts can short-circuit to a sensible local endpoint.
 */
export const KEYLESS_PROVIDER_DEFAULTS: Record<string, string> = {
	ollama: "http://localhost:11434/v1",
};

export type LoginParseResult = { provider: string; config: ProviderAuth } | { error: string };

/**
 * Parse the argument string of a `/login` command into a provider name and a
 * `ProviderAuth` blob. Returns `{ error }` on misuse instead of throwing so hosts
 * can render the error in their native message channel.
 *
 * Grammar: `<provider> [api_key="..."] [base_url="..."]`. Both kwargs optional;
 * if both are omitted and the provider has a `KEYLESS_PROVIDER_DEFAULTS` entry,
 * its `base_url` is used.
 */
export function parseLoginArgs(rest: string): LoginParseResult {
	let parsed: SlashArgs;
	try {
		parsed = parseSlashArgs(rest);
	} catch (err) {
		return { error: `usage: /login <provider> [api_key="..."] [base_url="..."]  (${String(err)})` };
	}
	const provider = parsed.positionals[0];
	if (!provider) {
		return { error: 'usage: /login <provider> [api_key="..."] [base_url="..."]' };
	}
	const config: ProviderAuth = {};
	if (parsed.kwargs.api_key !== undefined) config.api_key = { value: parsed.kwargs.api_key };
	if (parsed.kwargs.base_url !== undefined) config.base_url = parsed.kwargs.base_url;
	if (!config.api_key && !config.base_url) {
		const def = KEYLESS_PROVIDER_DEFAULTS[provider];
		if (def) config.base_url = def;
		else {
			return {
				error: `usage: /login ${provider} api_key="..." [base_url="..."]  (no keyless default for ${provider})`,
			};
		}
	}
	return { provider, config };
}

/** Render a `ProviderAuth` blob as a one-line summary for `/logins` output. */
export function formatProviderAuth(config: ProviderAuth): string {
	const parts: string[] = [];
	if (config.api_key) parts.push(`api_key=${config.api_key.value}`);
	if (config.base_url) parts.push(`base_url=${config.base_url}`);
	return parts.join(" ") || "(no fields)";
}
