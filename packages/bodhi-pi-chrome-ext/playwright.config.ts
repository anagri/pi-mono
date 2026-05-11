import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const here = fileURLToPath(new URL(".", import.meta.url));
const extIdPath = resolve(here, ".ext-id");
if (!existsSync(extIdPath)) {
	throw new Error(`.ext-id not found at ${extIdPath}. Run \`npm run gen-key\` first.`);
}
const extId = readFileSync(extIdPath, "utf8").trim();

export default defineConfig({
	testDir: "./e2e",
	globalSetup: "./e2e/global-setup.ts",
	timeout: 120_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: [["list"], ["html", { open: "never" }]],
	use: {
		baseURL: `chrome-extension://${extId}`,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "chromium", use: {} },
	],
});
