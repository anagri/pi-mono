import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// bodhi-pi reaches for `node:path` (in core + adapters) and `node:crypto`
// (`randomUUID`). Polyfill the path module via vite-plugin-node-polyfills;
// alias node:crypto to a tiny shim around `globalThis.crypto.randomUUID`
// (the crypto-browserify polyfill is fragile in worker realms). Both main
// thread and the agent worker need these — workers get their own plugins
// array under `worker.plugins`. Pattern mirrors packages/bodhi-pi-web.

const here = path.dirname(fileURLToPath(import.meta.url));
const cryptoShim = fileURLToPath(new URL("./src/frontend/lib/crypto-shim.ts", import.meta.url));

const polyfills = () =>
	nodePolyfills({
		include: ["path", "buffer", "events", "stream", "util"],
		globals: { Buffer: true, global: true, process: true },
	});

export default defineConfig({
	plugins: [react(), polyfills()],
	root: path.resolve(here, "src/frontend"),
	resolve: {
		alias: [
			{ find: /^node:crypto$/, replacement: cryptoShim },
			{ find: /^crypto$/, replacement: cryptoShim },
		],
	},
	server: {
		port: 35273,
		strictPort: true,
	},
	worker: {
		format: "es",
		plugins: () => [polyfills()],
	},
	build: {
		outDir: path.resolve(here, "dist/public"),
		emptyOutDir: true,
		sourcemap: true,
		chunkSizeWarningLimit: 2000,
	},
});
