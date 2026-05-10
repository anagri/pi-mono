import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, ".env") });
loadEnv({ path: path.resolve(here, ".env.test"), override: true });

export default defineConfig({
	testDir: "./e2e/playwright",
	testMatch: /.*\.spec\.ts$/,
	globalSetup: "./e2e/playwright/global-setup.ts",
	fullyParallel: true,
	workers: process.env.CI ? 2 : 4,
	reporter: "list",
	timeout: 60_000,
	expect: { timeout: 30_000 },
	use: {
		trace: "retain-on-failure",
	},
});
