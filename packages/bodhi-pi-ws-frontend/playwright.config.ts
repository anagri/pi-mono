import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// Load OPENAI_API_KEY etc. from the ws-server's .env so test.skip(!OPENAI_API_KEY) sees it,
// and so the spawned ws-server child processes inherit it.
loadEnv({ path: path.resolve(here, "../bodhi-pi-ws-server/.env") });
// e2e/.env.test (gitignored) layers on top — required for M12 anthropic-gated specs.
loadEnv({ path: path.resolve(here, "e2e/.env.test"), override: true });

const FRONTEND_PORT = 35273;

export default defineConfig({
	testDir: "./e2e",
	globalSetup: "./e2e/global-setup.ts",
	// Per-test isolation lives in spawnTestServer (own port + tmp SQLite) and
	// Playwright's per-test browser context, so workers share Vite safely.
	fullyParallel: true,
	workers: process.env.CI ? 2 : 4,
	reporter: "list",
	timeout: 60_000,
	expect: { timeout: 30_000 },
	use: {
		baseURL: `http://localhost:${FRONTEND_PORT}`,
		trace: "retain-on-failure",
	},
	// Backend ws-server is spawned per test by `spawnTestServer`; Playwright only
	// owns the Vite dev server here.
	webServer: {
		command: `npx --no-install vite --port ${FRONTEND_PORT} --strictPort`,
		url: `http://localhost:${FRONTEND_PORT}`,
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
