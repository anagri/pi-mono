import type { JsonValue, KvStore } from "./kv-store.js";

export function createInMemoryKvStore(): KvStore {
	const store = new Map<string, JsonValue>();
	return {
		async get(key: string): Promise<JsonValue | undefined> {
			return clone(store.get(key));
		},
		async set(key: string, value: JsonValue): Promise<void> {
			store.set(key, clone(value) as JsonValue);
		},
		async list(prefix?: string): Promise<Array<{ key: string; value: JsonValue }>> {
			const out: Array<{ key: string; value: JsonValue }> = [];
			for (const [key, value] of store) {
				if (!prefix || key.startsWith(prefix)) out.push({ key, value: clone(value) as JsonValue });
			}
			return out;
		},
		async remove(key: string): Promise<void> {
			store.delete(key);
		},
	};
}

function clone(v: JsonValue | undefined): JsonValue | undefined {
	return v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as JsonValue);
}
