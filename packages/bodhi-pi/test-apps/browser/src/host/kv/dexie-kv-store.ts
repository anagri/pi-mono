import type { JsonValue, KvStore } from "@bodhiapp/bodhi-pi";
import Dexie, { type Table } from "dexie";

export interface DexieKvStoreOptions {
	dbName?: string;
}

interface KvRow {
	key: string;
	json: string;
}

export function createDexieKvStore(opts: DexieKvStoreOptions = {}): KvStore {
	const db = new Dexie(opts.dbName ?? "bodhi-pi-browser-kv");
	db.version(2).stores({
		kv: "&key",
		kv_secret: null,
	});
	const table = db.table<KvRow, string>("kv");

	const decode = (row: KvRow | undefined): JsonValue | undefined =>
		row ? (JSON.parse(row.json) as JsonValue) : undefined;

	return {
		async get(key: string): Promise<JsonValue | undefined> {
			return decode(await table.get(key));
		},
		async list(prefix?: string): Promise<Array<{ key: string; value: JsonValue }>> {
			const rows = prefix ? await table.where("key").startsWith(prefix).toArray() : await table.toArray();
			return rows.map((r: KvRow) => ({ key: r.key, value: JSON.parse(r.json) as JsonValue }));
		},
		async set(key: string, value: JsonValue): Promise<void> {
			await table.put({ key, json: JSON.stringify(value) } as KvRow);
		},
		async remove(key: string): Promise<void> {
			await (table as Table<KvRow, string>).delete(key);
		},
	};
}
