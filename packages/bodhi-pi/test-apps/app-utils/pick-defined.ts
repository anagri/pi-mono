// Duplicated from packages/bodhi-pi/e2e/helpers/pick-defined.ts. test-apps/ is
// standalone — it must not import from e2e/. Keep this surface in lockstep
// with the e2e copy.

export function pickDefined<T extends Record<string, unknown>>(input: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(input)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}
