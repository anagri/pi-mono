import type { KvStore, KvStoreEntry, KvStoreSetOptions } from "./kv-store.js";

export function createInMemoryKvStore(): KvStore {
	const store = new Map<string, KvStoreEntry>();
	return {
		async get(key: string): Promise<string | undefined> {
			return store.get(key)?.value;
		},
		async list(prefix?: string): Promise<string[]> {
			const keys = [...store.keys()];
			return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
		},
		async getWithMeta(key: string): Promise<KvStoreEntry | undefined> {
			const entry = store.get(key);
			return entry ? { ...entry } : undefined;
		},
		async listWithMeta(prefix?: string): Promise<Array<{ key: string } & KvStoreEntry>> {
			const entries: Array<{ key: string } & KvStoreEntry> = [];
			for (const [key, entry] of store) {
				if (!prefix || key.startsWith(prefix)) entries.push({ key, ...entry });
			}
			return entries;
		},
		async set(key: string, value: string, opts?: KvStoreSetOptions): Promise<void> {
			store.set(key, { value, secret: opts?.secret === true });
		},
		async remove(key: string): Promise<void> {
			store.delete(key);
		},
	};
}
