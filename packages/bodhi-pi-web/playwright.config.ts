import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Load `.env` from this package so the dev server (started below) and
// e2e specs both see VITE_OPENAI_API_KEY. M3 e2e requires it; we throw
// here so config-time failures are loud rather than producing a
// confusing in-test "missing key" symptom.
loadEnv();

if (!process.env.VITE_OPENAI_API_KEY) {
	throw new Error(
		"VITE_OPENAI_API_KEY is required for bodhi-pi-web e2e. Copy packages/bodhi-pi-cli/.env to packages/bodhi-pi-web/.env and re-prefix keys with VITE_.",
	);
}

export default defineConfig({
	testDir: "./e2e",
	timeout: 120_000,
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: [["list"], ["html", { open: "never" }]],
	use: {
		baseURL: "http://localhost:35173",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: "npm run dev",
		url: "http://localhost:35173",
		reuseExistingServer: false,
		timeout: 60_000,
		stdout: "pipe",
		stderr: "pipe",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
