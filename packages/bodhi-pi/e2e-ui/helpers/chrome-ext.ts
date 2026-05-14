import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME_EXT_DIR = path.resolve(here, "..", "..", "e2e", "test-app-chrome-ext");
const DIST = path.resolve(CHROME_EXT_DIR, "dist");
const EXT_ID_PATH = path.resolve(CHROME_EXT_DIR, ".ext-id");

export function getExtensionId(): string {
	if (!existsSync(EXT_ID_PATH)) {
		throw new Error(`.ext-id not found at ${EXT_ID_PATH}. Run \`npm run gen-key\` in test-app-chrome-ext first.`);
	}
	return readFileSync(EXT_ID_PATH, "utf8").trim();
}

export function chromeExtBaseUrl(): string {
	return `chrome-extension://${getExtensionId()}/index.html`;
}

export async function launchExtensionContext(): Promise<BrowserContext> {
	if (!existsSync(DIST)) {
		throw new Error(`dist/ not found at ${DIST}. Run \`npm run build\` in test-app-chrome-ext first.`);
	}
	const headed = process.env.HEADED === "1";
	const args = [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-sandbox"];
	if (!headed) args.push("--headless=new");
	return chromium.launchPersistentContext("", { headless: false, args });
}
