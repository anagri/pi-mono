import type { KvStore, KvStoreEntry, KvStoreSetOptions } from "@bodhiapp/bodhi-pi";
import Dexie, { type Table } from "dexie";

export interface DexieKvStoreOptions {
	dbName?: string;
}

interface KvRow {
	key: string;
	value: string;
}

/**
 * Dexie-backed `KvStore`. Two tables segregate secret entries from public ones —
 * a structural hint for hosts that want to add encryption-at-rest later. No
 * crypto is applied here.
 */
export function createDexieKvStore(opts: DexieKvStoreOptions = {}): KvStore {
	const db = new Dexie(opts.dbName ?? "bodhi-pi-browser-kv");
	db.version(1).stores({
		kv: "&key",
		kv_secret: "&key",
	});
	const publicTable = db.table<KvRow, string>("kv");
	const secretTable = db.table<KvRow, string>("kv_secret");

	async function getRow(key: string): Promise<{ row: KvRow; secret: boolean } | undefined> {
		const secretRow = await secretTable.get(key);
		if (secretRow) return { row: secretRow, secret: true };
		const publicRow = await publicTable.get(key);
		if (publicRow) return { row: publicRow, secret: false };
		return undefined;
	}

	return {
		async get(key: string): Promise<string | undefined> {
			return (await getRow(key))?.row.value;
		},
		async getWithMeta(key: string): Promise<KvStoreEntry | undefined> {
			const found = await getRow(key);
			return found ? { value: found.row.value, secret: found.secret } : undefined;
		},
		async list(prefix?: string): Promise<string[]> {
			const collect = async (t: Table<KvRow, string>): Promise<string[]> => {
				const rows = prefix ? await t.where("key").startsWith(prefix).toArray() : await t.toArray();
				return rows.map((r) => r.key);
			};
			const [pub, sec] = await Promise.all([collect(publicTable), collect(secretTable)]);
			return [...new Set([...pub, ...sec])];
		},
		async listWithMeta(prefix?: string): Promise<Array<{ key: string } & KvStoreEntry>> {
			const out = new Map<string, { key: string } & KvStoreEntry>();
			const pubRows = prefix
				? await publicTable.where("key").startsWith(prefix).toArray()
				: await publicTable.toArray();
			for (const r of pubRows) out.set(r.key, { key: r.key, value: r.value, secret: false });
			const secRows = prefix
				? await secretTable.where("key").startsWith(prefix).toArray()
				: await secretTable.toArray();
			// Secret rows win on key conflict.
			for (const r of secRows) out.set(r.key, { key: r.key, value: r.value, secret: true });
			return [...out.values()];
		},
		async set(key: string, value: string, opts?: KvStoreSetOptions): Promise<void> {
			if (opts?.secret === true) {
				await publicTable.delete(key);
				await secretTable.put({ key, value });
			} else {
				await secretTable.delete(key);
				await publicTable.put({ key, value });
			}
		},
		async remove(key: string): Promise<void> {
			await publicTable.delete(key);
			await secretTable.delete(key);
		},
	};
}
