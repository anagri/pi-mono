export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Host-injected key-value store. `auth/<provider>` is the only prefix bodhi-pi reserves.
 * `get` resolves `undefined` for a missing key (no rejection); `remove` is a no-op for a
 * missing key. Optional in `BodhiPiConfig` — without it, `/login` and `_bodhi-pi/kv/*` are
 * unavailable but `getApiKey` still works.
 */
export interface KvStore {
	get(key: string): Promise<JsonValue | undefined>;
	set(key: string, value: JsonValue): Promise<void>;
	list(prefix?: string): Promise<Array<{ key: string; value: JsonValue }>>;
	remove(key: string): Promise<void>;
}

export const AUTH_PREFIX = "auth/";

/** Deep-copies `value`, replacing `value` strings on `{ secret: true }` nodes with `"***"`. */
export function maskSecrets(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(maskSecrets);
	if (value !== null && typeof value === "object") {
		const obj = value as { [k: string]: JsonValue };
		const out: { [k: string]: JsonValue } = {};
		const isSecretNode = typeof obj.value === "string" && obj.secret === true;
		for (const k of Object.keys(obj)) {
			if (isSecretNode && k === "value") {
				out.value = "***";
			} else {
				out[k] = maskSecrets(obj[k]);
			}
		}
		return out;
	}
	return value;
}

export function containsSecret(value: JsonValue): boolean {
	if (Array.isArray(value)) return value.some(containsSecret);
	if (value !== null && typeof value === "object") {
		const obj = value as { [k: string]: JsonValue };
		if (typeof obj.value === "string" && obj.secret === true) return true;
		for (const k of Object.keys(obj)) if (containsSecret(obj[k])) return true;
	}
	return false;
}
