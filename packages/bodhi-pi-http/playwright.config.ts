import { defineConfig } from "@playwright/test";

/**
 * Playwright skeleton — frontend e2e tests are deferred per the PoC plan.
 * The config exists so the harness is ready when we add specs in M9 (optional).
 */
export default defineConfig({
	testDir: "./e2e/playwright",
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: "list",
	use: {
		baseURL: "http://localhost:3000",
		trace: "retain-on-failure",
	},
});
