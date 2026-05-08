import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// bodhi-pi reaches for `node:path` via the in-memory adapter and tool helpers,
// and `node:crypto.randomUUID` from the in-memory session store. We polyfill
// `path` (and a few transitive utilities) but explicitly alias `node:crypto`
// to a tiny shim around `globalThis.crypto.randomUUID` — the heavy
// `crypto-browserify` polyfill that vite-plugin-node-polyfills ships fails at
// import time in a worker context. We do NOT polyfill `fs`/`child_process`;
// those code paths only live in `@bodhiapp/bodhi-pi-node` which never ships
// into this app.
const cryptoShim = fileURLToPath(new URL("./src/agent/crypto-shim.ts", import.meta.url));

export default defineConfig({
	plugins: [
		react(),
		nodePolyfills({
			include: ["path", "buffer", "events", "stream", "util"],
			globals: { Buffer: true, global: true, process: true },
		}),
	],
	resolve: {
		alias: [
			{ find: /^node:crypto$/, replacement: cryptoShim },
			{ find: /^crypto$/, replacement: cryptoShim },
		],
	},
	server: { port: 35173, strictPort: true },
	worker: {
		format: "es",
		plugins: () => [
			nodePolyfills({
				include: ["path", "buffer", "events", "stream", "util"],
				globals: { Buffer: true, global: true, process: true },
			}),
		],
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
	},
});
