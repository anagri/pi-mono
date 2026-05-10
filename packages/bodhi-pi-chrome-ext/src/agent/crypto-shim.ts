/**
 * Browser/Worker-compatible shim for the subset of `node:crypto` bodhi-pi
 * actually uses (`randomUUID`). Aliased in vite.config.ts so neither the
 * worker nor the main bundle pulls in the heavyweight `crypto-browserify`
 * polyfill, which has historically been fragile.
 */
const c = globalThis.crypto;

if (!c || typeof c.randomUUID !== "function") {
	throw new Error("globalThis.crypto.randomUUID is not available");
}

export const randomUUID: () => string = () => c.randomUUID();
export const webcrypto = c;
export default { randomUUID, webcrypto };
