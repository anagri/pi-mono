import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Mirrors test-app-browser's polyfill + crypto-shim pattern, but ships an
// unpacked MV3 extension instead of a Vite dev server. `base: "./"` so the
// emitted HTML/asset URLs work under chrome-extension://. Rollup has two
// HTML inputs (index for the agent page, sandbox for the AsyncFunction
// iframe) — no background service worker: Playwright opens the page URL
// directly, no user gesture needed.

const here = path.dirname(fileURLToPath(import.meta.url));
const cryptoShim = fileURLToPath(new URL("./src/host/crypto-shim.ts", import.meta.url));

const polyfills = () =>
	nodePolyfills({
		include: ["path", "buffer", "events", "stream", "util"],
		globals: { Buffer: true, global: true, process: true },
	});

export default defineConfig({
	base: "./",
	plugins: [react(), polyfills()],
	resolve: {
		alias: [
			{ find: /^node:crypto$/, replacement: cryptoShim },
			{ find: /^crypto$/, replacement: cryptoShim },
		],
	},
	worker: {
		format: "es",
		plugins: () => [polyfills()],
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
	},
	build: {
		outDir: path.resolve(here, "dist"),
		emptyOutDir: true,
		sourcemap: true,
		chunkSizeWarningLimit: 2000,
		rollupOptions: {
			input: {
				index: path.resolve(here, "index.html"),
				sandbox: path.resolve(here, "sandbox.html"),
			},
			output: {
				entryFileNames: "assets/[name]-[hash].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
});
