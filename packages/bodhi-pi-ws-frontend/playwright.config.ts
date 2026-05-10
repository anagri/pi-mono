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

if (!process.env.ANTHROPIC_API_KEY) {
	throw new Error(
		"ANTHROPIC_API_KEY is required for ws-frontend e2e tests. " +
			"Copy packages/bodhi-pi/e2e/.env.test → packages/bodhi-pi-ws-frontend/e2e/.env.test.",
	);
}

const FRONTEND_PORT = 35273;

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	timeout: 60_000,
	use: {
		baseURL: `http://localhost:${FRONTEND_PORT}`,
		trace: "retain-on-failure",
	},
	// Backend ws-server is spawned per test by `spawnTestServer` in e2e/helpers; only
	// the frontend dev server is started by Playwright here.
	webServer: {
		command: `npx --no-install vite --port ${FRONTEND_PORT} --strictPort`,
		url: `http://localhost:${FRONTEND_PORT}`,
		reuseExistingServer: false,
		timeout: 30_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
