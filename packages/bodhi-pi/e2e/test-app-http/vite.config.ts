import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
	plugins: [react()],
	root: path.resolve(here, "src/frontend"),
	publicDir: path.resolve(here, "src/frontend/public"),
	resolve: {
		alias: [{ find: "@e2e", replacement: path.resolve(here, "..") }],
	},
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/acp": {
				target: "http://localhost:3000",
				changeOrigin: false,
				ws: false,
			},
			"/acp-ws": {
				target: "ws://localhost:3000",
				changeOrigin: false,
				ws: true,
			},
			"/healthz": {
				target: "http://localhost:3000",
				changeOrigin: false,
			},
		},
	},
	build: {
		outDir: path.resolve(here, "dist/public"),
		emptyOutDir: true,
		sourcemap: true,
	},
});
