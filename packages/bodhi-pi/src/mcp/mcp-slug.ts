import type { KvStore } from "../kv/kv-store.js";
import { MCP_PREFIX } from "./mcp-types.js";

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

export function slugifyCommand(command: string, args: string[] | undefined): string {
	const all = [command, ...(args ?? [])];
	const nonFlag = all.filter((t) => t && !t.startsWith("-"));
	const packageRef = nonFlag.find((t) => t.includes("/") || t.startsWith("@"));
	const chosen = packageRef ?? nonFlag[nonFlag.length - 1] ?? command;
	const basename = chosen.split("/").pop() ?? chosen;
	const trimmed = basename.replace(/^@[^/]+\//, "");
	return sanitize(trimmed);
}

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
