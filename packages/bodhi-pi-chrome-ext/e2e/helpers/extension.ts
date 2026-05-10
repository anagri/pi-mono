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
	// `--headless=new` is the only headless mode that loads MV3 extensions
	// (Chrome 119+). Pair with `headless: false` so Playwright doesn't add
	// its own `--headless=old` flag.
	const headed = process.env.HEADED === "1";
	const args = [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-sandbox"];
	if (!headed) args.push("--headless=new");
	return chromium.launchPersistentContext("", {
		headless: false,
		args,
	});
}
