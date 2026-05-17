import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// bodhi-pi/src/ is runtime-neutral as of the no-`node:*` rule in
// packages/bodhi-pi/CLAUDE.md — no `nodePolyfills` or `node:crypto` alias
// needed here. The main thread and the worker both bundle straight against
// the package without any Node shimming.

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [react()],
	root: path.resolve(here, "src/client/react"),
	server: {
		port: 35273,
		strictPort: true,
	},
	worker: {
		format: "es",
	},
	build: {
		outDir: path.resolve(here, "dist/public"),
		emptyOutDir: true,
		sourcemap: true,
		chunkSizeWarningLimit: 2000,
	},
});
