import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { containsSecret, type JsonValue, type KvStore } from "@bodhiapp/bodhi-pi";
import { decodeKey, encodeKey } from "./key-encoding.js";

export interface NodeKvStoreOptions {
	dir?: string;
}

function entryPath(dir: string, key: string): string {
	return path.join(dir, `${encodeKey(key)}.json`);
}

async function readValue(filePath: string): Promise<JsonValue | undefined> {
	let raw: string;
	try {
		raw = await readFile(filePath, { encoding: "utf8" });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
	return JSON.parse(raw) as JsonValue;
}

export function createNodeKvStore(dir: string): KvStore {
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
		async get(key: string): Promise<JsonValue | undefined> {
			await init();
			return await readValue(entryPath(dir, key));
		},
		async set(key: string, value: JsonValue): Promise<void> {
			await init();
			const secret = containsSecret(value);
			const filePath = entryPath(dir, key);
			const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
			const payload = JSON.stringify(value);
			await writeFile(tmpPath, payload, { mode: secret ? 0o600 : 0o644 });
			await rename(tmpPath, filePath);
			if (secret) await chmod(filePath, 0o600);
		},
		async list(prefix?: string): Promise<Array<{ key: string; value: JsonValue }>> {
			const files = await listFiles();
			const out: Array<{ key: string; value: JsonValue }> = [];
			for (const f of files) {
				const key = decodeKey(f.replace(/\.json$/, ""));
				if (prefix && !key.startsWith(prefix)) continue;
				const value = await readValue(path.join(dir, f));
				if (value !== undefined) out.push({ key, value });
			}
			return out;
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
