import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

loadEnv({ path: path.join(here, "e2e", ".env.test"), override: true });

const base = typeof baseConfig === "function" ? baseConfig({ command: "serve", mode: "test" }) : baseConfig;

const sharedProjectTest = {
	globals: true,
	environment: "node" as const,
	testTimeout: 30_000,
	globalSetup: ["./e2e/global-setup.ts"],
};

export default defineConfig({
	plugins: base.plugins,
	resolve: base.resolve,
	test: {
		projects: [
			{
				plugins: base.plugins,
				resolve: base.resolve,
				test: {
					...sharedProjectTest,
					name: "in-memory",
					setupFiles: ["./e2e/setup/in-memory.ts"],
					include: ["e2e/shared/**/*.e2e.ts"],
				},
			},
			{
				plugins: base.plugins,
				resolve: base.resolve,
				test: {
					...sharedProjectTest,
					name: "cli",
					setupFiles: ["./e2e/setup/cli.ts"],
					include: ["e2e/shared/**/*.e2e.ts", "e2e/cli-headless/**/*.e2e.ts"],
				},
			},
			{
				plugins: base.plugins,
				resolve: base.resolve,
				test: {
					...sharedProjectTest,
					name: "http",
					setupFiles: ["./e2e/setup/http.ts"],
					include: ["e2e/shared/**/*.e2e.ts"],
				},
			},
			{
				plugins: base.plugins,
				resolve: base.resolve,
				test: {
					...sharedProjectTest,
					name: "ws",
					setupFiles: ["./e2e/setup/ws.ts"],
					include: ["e2e/shared/**/*.e2e.ts"],
				},
			},
		],
	},
});
