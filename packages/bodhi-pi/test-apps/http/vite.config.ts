import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(new URL(import.meta.url).pathname);

// Server target uses 127.0.0.1 (IPv4 explicit) instead of `localhost` to avoid
// collisions with other dev servers squatting on [::1]:3000 — macOS resolves
// `localhost` to IPv6 ::1 first, and Node `http.createServer` listens on the
// wildcard *:3000 which loses the [::1]:3000 binding race against more-specific
// IPv6 listeners. See packages/bodhi-pi/test-apps/http/src/host/index.ts:14.
const SERVER_TARGET = "http://127.0.0.1:3000";
const SERVER_WS_TARGET = "ws://127.0.0.1:3000";

export default defineConfig({
	plugins: [react()],
	root: path.resolve(here, "src/client/react"),
	publicDir: path.resolve(here, "src/client/react/public"),
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/acp": { target: SERVER_TARGET, changeOrigin: false, ws: false },
			"/acp-ws": { target: SERVER_WS_TARGET, changeOrigin: false, ws: true },
			"/healthz": { target: SERVER_TARGET, changeOrigin: false },
			"/provision": { target: SERVER_TARGET, changeOrigin: false },
			"/oauth/callback": { target: SERVER_TARGET, changeOrigin: false },
		},
	},
	build: {
		outDir: path.resolve(here, "dist/public"),
		emptyOutDir: true,
		sourcemap: true,
	},
});
