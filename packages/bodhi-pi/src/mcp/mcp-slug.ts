import type { KvStore } from "../kv/kv-store.js";
import { MCP_PREFIX } from "./mcp-types.js";

/**
 * Derive a candidate slug from a server URL.
 *
 * Strategy: take the leftmost non-generic label from the host.
 *   https://mcp.github.com/...   → "github"
 *   https://api.example.io/mcp   → "example"
 *   https://foo.bar.baz.com      → "bar"
 *
 * Returns empty string if no usable label can be extracted.
 */
export function slugifyUrl(url: string): string {
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return "";
	}
	const labels = host.split(".").filter((l) => l.length > 0);
	if (labels.length === 0) return "";
	const GENERIC = new Set(["mcp", "api", "www"]);
	const tld = new Set(["com", "io", "net", "org", "dev", "co", "ai", "app", "sh", "xyz"]);
	const meaningful = labels.filter((l, i) => !(i === 0 && GENERIC.has(l)) && !(i === labels.length - 1 && tld.has(l)));
	const pick = meaningful[0] ?? labels[0];
	return sanitize(pick);
}

/**
 * Derive a candidate slug from a stdio command.
 *
 *   npx -y @modelcontextprotocol/server-github stdio   → "server-github"
 *   npx @scope/foo                                     → "foo"
 *   /usr/bin/my-mcp                                    → "my-mcp"
 *
 * Strategy: prefer a token that looks like a package ref (contains `/` or starts with `@`)
 * since those are unambiguous server identities; fall back to the last non-flag token.
 */
export function slugifyCommand(command: string, args: string[] | undefined): string {
	const all = [command, ...(args ?? [])];
	const nonFlag = all.filter((t) => t && !t.startsWith("-"));
	const packageRef = nonFlag.find((t) => t.includes("/") || t.startsWith("@"));
	const chosen = packageRef ?? nonFlag[nonFlag.length - 1] ?? command;
	const basename = chosen.split("/").pop() ?? chosen;
	const trimmed = basename.replace(/^@[^/]+\//, "");
	return sanitize(trimmed);
}

/**
 * Resolve a candidate slug to one that does not collide with any existing
 * `mcp/<slug>` entry in `kvStore`. On collision, append `-<5-char random hex>`.
 */
export async function resolveUniqueSlug(candidate: string, kvStore: KvStore): Promise<string> {
	const base = candidate.length > 0 ? candidate : "mcp";
	const existing = new Set((await kvStore.list(MCP_PREFIX)).map((e) => e.key.slice(MCP_PREFIX.length)));
	if (!existing.has(base)) return base;
	for (let attempt = 0; attempt < 16; attempt++) {
		const suffix = randomHex(5);
		const candidate = `${base}-${suffix}`;
		if (!existing.has(candidate)) return candidate;
	}
	throw new Error(`could not resolve unique slug for "${base}" after 16 attempts`);
}

function sanitize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function randomHex(len: number): string {
	let out = "";
	while (out.length < len) {
		out += Math.floor(Math.random() * 0x10000)
			.toString(16)
			.padStart(4, "0");
	}
	return out.slice(0, len);
}
