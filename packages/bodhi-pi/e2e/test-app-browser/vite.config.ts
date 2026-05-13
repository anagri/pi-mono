import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
	plugins: [react()],
	root: path.resolve(here, "src/frontend"),
	resolve: {
		alias: {
			"@e2e": path.resolve(here, ".."),
		},
	},
	server: {
		port: 35273,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(here, "dist/public"),
		emptyOutDir: true,
		sourcemap: true,
	},
});
