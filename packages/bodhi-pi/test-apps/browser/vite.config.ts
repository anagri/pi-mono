import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// bodhi-pi/src/ AND its test-app adapters (notably
// test-apps/app-utils/just-bash-fs-adapter.ts) are runtime-neutral — see
// packages/bodhi-pi/CLAUDE.md "Source code rules". No Node polyfills are
// shipped here: any future regression that pulls `node:*` into a browser
// bundle should be fixed at the source rather than papered over with a
// polyfill plugin (the previous polyfills hid a one-line `node:path` import
// in just-bash-fs-adapter that broke the bash tool's shared-fs round-trip
// once they were removed).
//
// `just-bash` itself has a `node:zlib` static import in its browser bundle,
// but Vite externalises it into a getter-trap that only throws on first
// property read — and the bash tool here never invokes gzip/gunzip/zcat,
// so the binding is never resolved. Leave it alone unless a future use of
// those commands forces our hand.

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
