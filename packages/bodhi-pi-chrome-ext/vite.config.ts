import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Mirrors bodhi-pi-web's polyfill config exactly. The crypto-shim alias
// bypasses crypto-browserify, which fails in worker contexts.
const cryptoShim = fileURLToPath(new URL("./src/agent/crypto-shim.ts", import.meta.url));

export default defineConfig({
	base: "./",
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
	build: {
		outDir: "dist",
		emptyOutDir: true,
		chunkSizeWarningLimit: 2000,
		rollupOptions: {
			input: {
				index: resolve(__dirname, "index.html"),
				background: resolve(__dirname, "src/background.ts"),
			},
			output: {
				// Background SW must live at a stable path that manifest.json points at.
				entryFileNames: (chunk) =>
					chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
});
