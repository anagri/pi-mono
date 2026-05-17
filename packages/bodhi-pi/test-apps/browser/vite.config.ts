import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// bodhi-pi/src/ is runtime-neutral (see packages/bodhi-pi/CLAUDE.md "Source
// code rules") — no `node:crypto` shim needed for bodhi-pi itself. The
// polyfills below stay because `just-bash` (the browser bash adapter used by
// the bash tool) reaches for Node's `buffer`/`events`/`stream`/`util` at
// runtime — without these, the bash tool round-trips silently fail in the
// browser/chrome-ext matrix entries. Both main thread and worker need them.

const here = path.dirname(fileURLToPath(import.meta.url));

const polyfills = () =>
	nodePolyfills({
		include: ["path", "buffer", "events", "stream", "util"],
		globals: { Buffer: true, global: true, process: true },
	});

export default defineConfig({
	plugins: [react(), polyfills()],
	root: path.resolve(here, "src/client/react"),
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
