/** Narrowing predicate for plain (non-array, non-null) JS objects. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Return a shallow copy of `obj` containing only entries whose values are not `undefined`.
 * Replaces the `...(x !== undefined ? { x } : {})` ternary-spread pattern at call sites.
 */
export function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const key in obj) {
		if (obj[key] !== undefined) out[key] = obj[key];
	}
	return out;
}
