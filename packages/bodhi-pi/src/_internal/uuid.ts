/**
 * Runtime-neutral UUID source. Wraps `globalThis.crypto.randomUUID()` so the
 * core can mint opaque session/entry IDs without importing `node:crypto`
 * (which traps when externalised in browser/Worker/MV3 bundles).
 *
 * `crypto.randomUUID` is available in Node ≥19, all modern browsers, Web
 * Workers, and MV3 service workers. Hosts that run on older runtimes must
 * polyfill `globalThis.crypto` before constructing the agent.
 */
export function randomUUID(): string {
	const c = globalThis.crypto;
	if (!c || typeof c.randomUUID !== "function") {
		throw new Error("bodhi-pi: globalThis.crypto.randomUUID is unavailable in this runtime");
	}
	return c.randomUUID();
}
