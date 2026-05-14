// Spread optional fields without the `...(opts.x !== undefined ? { x: opts.x } : {})`
// boilerplate at every site.
export function pickDefined<T extends Record<string, unknown>>(input: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(input)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}
