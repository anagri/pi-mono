// Browser/Worker shim for the `node:crypto` subset bodhi-pi uses
// (`randomUUID`). Aliased in vite.config.ts so neither the main bundle nor
// the worker pulls in the heavy `crypto-browserify` polyfill.

const c = globalThis.crypto;

if (!c || typeof c.randomUUID !== "function") {
	throw new Error("globalThis.crypto.randomUUID is not available");
}

export const randomUUID: () => string = () => c.randomUUID();
export const webcrypto = c;
export default { randomUUID, webcrypto };
