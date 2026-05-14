import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { chromeExtBaseUrl } from "./helpers/chrome-ext.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "..", "e2e", ".env.test") });

const TEST_APP_HTTP = path.resolve(here, "..", "test-apps", "http");
const TEST_APP_BROWSER = path.resolve(here, "..", "test-apps", "browser");
const HTTP_PORT = 35373;
const BROWSER_PORT = 35473;

export default defineConfig({
	testDir: "./shared",
	globalSetup: "./global-setup.ts",
	timeout: 120_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: [["list"], ["html", { open: "never" }]],
	use: {
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},
	webServer: [
		{
			command: `cd "${TEST_APP_HTTP}" && npm run build && node dist/test-app-http/src/server/index.js --port ${HTTP_PORT} --models openai:gpt-4o-mini,anthropic:claude-haiku-4-5-20251001 --default-model gpt-4o-mini --data-dir .e2e-ui-data`,
			url: `http://localhost:${HTTP_PORT}/healthz`,
			reuseExistingServer: false,
			timeout: 180_000,
			stdout: "pipe",
			stderr: "pipe",
		},
		{
			command: `cd "${TEST_APP_BROWSER}" && npm run build && npx vite preview --port ${BROWSER_PORT} --strictPort`,
			url: `http://localhost:${BROWSER_PORT}`,
			reuseExistingServer: false,
			timeout: 180_000,
			stdout: "pipe",
			stderr: "pipe",
		},
	],
	projects: [
		{
			name: "http",
			testMatch: ["**/*.spec.ts"],
			use: {
				...devices["Desktop Chrome"],
				baseURL: `http://localhost:${HTTP_PORT}`,
			},
			metadata: { transportPath: "/http" },
		},
		{
			name: "ws",
			testMatch: ["**/*.spec.ts"],
			use: {
				...devices["Desktop Chrome"],
				baseURL: `http://localhost:${HTTP_PORT}`,
			},
			metadata: { transportPath: "/ws" },
		},
		{
			name: "browser",
			testMatch: ["**/*.spec.ts"],
			use: {
				...devices["Desktop Chrome"],
				baseURL: `http://localhost:${BROWSER_PORT}`,
			},
			metadata: { transportPath: "/", inProcessAgent: true },
		},
		{
			name: "chrome-ext",
			testMatch: ["**/*.spec.ts"],
			use: {
				baseURL: chromeExtBaseUrl(),
			},
			metadata: { transportPath: "/index.html", inProcessAgent: true, chromeExt: true },
		},
	],
});
