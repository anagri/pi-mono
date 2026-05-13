export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface KvStore {
	get(key: string): Promise<JsonValue | undefined>;
	set(key: string, value: JsonValue): Promise<void>;
	list(prefix?: string): Promise<Array<{ key: string; value: JsonValue }>>;
	remove(key: string): Promise<void>;
}

export const AUTH_PREFIX = "auth/";

/**
 * Recursively masks any `{ value: string, secret: true }` node by replacing its
 * `value` with "***". Returns a deep copy; the input is not mutated. Sibling
 * keys on a secret node are preserved; `secret: false` is a no-op.
 */
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

/** True if `maskSecrets(value)` would mutate any node — i.e. the tree contains at least one secret marker. */
export function containsSecret(value: JsonValue): boolean {
	if (Array.isArray(value)) return value.some(containsSecret);
	if (value !== null && typeof value === "object") {
		const obj = value as { [k: string]: JsonValue };
		if (typeof obj.value === "string" && obj.secret === true) return true;
		for (const k of Object.keys(obj)) if (containsSecret(obj[k])) return true;
	}
	return false;
}
