export interface KvStoreSetOptions {
	secret?: boolean;
}

export interface KvStoreEntry {
	value: string;
	secret: boolean;
}

/**
 * Host-injected key-value store. Used today for API-key persistence under the
 * `auth/<provider>` prefix; reusable for future per-host KV needs.
 *
 * `get`/`list` return unmasked values for in-process consumers (e.g. agent
 * API-key resolution). `getWithMeta`/`listWithMeta` return the secret flag so
 * ACP read handlers can mask before responding to clients.
 */
export interface KvStore {
	get(key: string): Promise<string | undefined>;
	list(prefix?: string): Promise<string[]>;
	getWithMeta(key: string): Promise<KvStoreEntry | undefined>;
	listWithMeta(prefix?: string): Promise<Array<{ key: string } & KvStoreEntry>>;
	set(key: string, value: string, opts?: KvStoreSetOptions): Promise<void>;
	remove(key: string): Promise<void>;
}

export const AUTH_PREFIX = "auth/";
