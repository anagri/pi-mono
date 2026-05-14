export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Host-injected key-value store the agent uses for provider auth tokens (`auth/<provider>`) and
 * any extension-defined keys.
 *
 * **Contract:**
 * - Keys are arbitrary strings; bodhi-pi only reserves the `auth/` prefix.
 * - Values are JSON-serialisable. The agent layers a "secret" marker on string values that
 *   should be masked on read (`{ value: "...", secret: true }` — see {@link maskSecrets}).
 * - `get` returns `undefined` for a missing key (no rejection). `set` overwrites. `remove` is a
 *   no-op for a missing key.
 * - `list(prefix)` returns key/value pairs sorted in any order. Implementations may stream.
 * - bodhi-pi calls these methods on every prompt; implementations SHOULD be in-memory caches or
 *   fast on-disk stores.
 *
 * Optional. Hosts that omit `BodhiPiConfig.kvStore` lose `_bodhi-pi/kv/*` ext-method support and
 * the `/login` slash command — auth still works via `BodhiPiConfig.getApiKey`.
 */
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
