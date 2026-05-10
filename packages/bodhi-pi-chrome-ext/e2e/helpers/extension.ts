import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const DIST = resolve(ROOT, "dist");
const EXT_ID_PATH = resolve(ROOT, ".ext-id");

export function getExtensionId(): string {
	if (!existsSync(EXT_ID_PATH)) {
		throw new Error(`.ext-id not found at ${EXT_ID_PATH}. Run \`npm run gen-key\` first.`);
	}
	return readFileSync(EXT_ID_PATH, "utf8").trim();
}

export function getDistPath(): string {
	if (!existsSync(DIST)) {
		throw new Error(`dist/ not found at ${DIST}. Run \`npm run build\` first.`);
	}
	return DIST;
}

export async function launchExtensionContext(): Promise<BrowserContext> {
	const dist = getDistPath();
	// MV3 extensions need new headless explicitly. Playwright's `headless: true`
	// in recent versions defaults to new headless, but Chromium <119 ignores
	// extensions there — pass `--headless=new` explicitly so failures surface
	// as launch errors rather than silent ERR_BLOCKED_BY_CLIENT.
	return chromium.launchPersistentContext("", {
		// Extensions don't reliably load in headless mode (ERR_BLOCKED_BY_CLIENT
		// at chrome-extension://<id>/index.html). Headed is the supported path.
		headless: false,
		args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-sandbox"],
	});
}
