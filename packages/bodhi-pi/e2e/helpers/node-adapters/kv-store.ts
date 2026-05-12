import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { KvStore, KvStoreEntry, KvStoreSetOptions } from "@bodhiapp/bodhi-pi";
import { decodeKey, encodeKey } from "./key-encoding.js";

export interface NodeKvStoreOptions {
	dir?: string;
}

function defaultKvDir(): string {
	return path.join(homedir(), ".bodhi-pi", "kv");
}

function entryPath(dir: string, key: string): string {
	return path.join(dir, `${encodeKey(key)}.json`);
}

async function readEntry(filePath: string): Promise<KvStoreEntry | undefined> {
	let raw: string;
	try {
		raw = await readFile(filePath, { encoding: "utf8" });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
	const parsed = JSON.parse(raw) as { value: unknown; secret: unknown };
	if (typeof parsed.value !== "string" || typeof parsed.secret !== "boolean") {
		throw new Error(`malformed KV entry at ${filePath}`);
	}
	return { value: parsed.value, secret: parsed.secret };
}

// File-backed KvStore. One JSON file per key. Secret entries: 0o600. Dir: 0o700.
export function createNodeKvStore(opts: NodeKvStoreOptions = {}): KvStore {
	const dir = opts.dir ?? defaultKvDir();
	let initialized = false;
	async function init(): Promise<void> {
		if (initialized) return;
		await mkdir(dir, { recursive: true, mode: 0o700 });
		initialized = true;
	}

	async function listFiles(): Promise<string[]> {
		await init();
		try {
			const entries = await readdir(dir);
			return entries.filter((f) => f.endsWith(".json"));
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw e;
		}
	}

	return {
		async get(key: string): Promise<string | undefined> {
			await init();
			const entry = await readEntry(entryPath(dir, key));
			return entry?.value;
		},
		async getWithMeta(key: string): Promise<KvStoreEntry | undefined> {
			await init();
			return await readEntry(entryPath(dir, key));
		},
		async list(prefix?: string): Promise<string[]> {
			const files = await listFiles();
			const keys = files.map((f) => decodeKey(f.replace(/\.json$/, "")));
			return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
		},
		async listWithMeta(prefix?: string): Promise<Array<{ key: string } & KvStoreEntry>> {
			const files = await listFiles();
			const out: Array<{ key: string } & KvStoreEntry> = [];
			for (const f of files) {
				const key = decodeKey(f.replace(/\.json$/, ""));
				if (prefix && !key.startsWith(prefix)) continue;
				const entry = await readEntry(path.join(dir, f));
				if (entry) out.push({ key, ...entry });
			}
			return out;
		},
		async set(key: string, value: string, opts?: KvStoreSetOptions): Promise<void> {
			await init();
			const secret = opts?.secret === true;
			const filePath = entryPath(dir, key);
			const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
			const payload = JSON.stringify({ value, secret });
			await writeFile(tmpPath, payload, { mode: secret ? 0o600 : 0o644 });
			await rename(tmpPath, filePath);
			if (secret) await chmod(filePath, 0o600);
		},
		async remove(key: string): Promise<void> {
			await init();
			try {
				await rm(entryPath(dir, key));
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
				throw e;
			}
		},
	};
}
