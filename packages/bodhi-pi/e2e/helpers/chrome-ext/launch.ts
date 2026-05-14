import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "playwright";
import { type HarnessSetupOptions, runHarnessSetupOnPage } from "../browser/page-setup.js";

// Singleton persistent context for the whole vitest run. MV3 extensions
// require `chromium.launchPersistentContext` (regular launch + newContext
// can't host an unpacked extension), so we boot one persistent profile in
// a fresh tmpdir, share it across all chrome-ext harnesses, and rely on
// the per-test random userId to namespace each test's Dexie dbName.

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CHROME_EXT_DIR = path.resolve(here, "../../test-app-chrome-ext");
const DIST_PATH = path.resolve(TEST_APP_CHROME_EXT_DIR, "dist");
const EXT_ID_PATH = path.resolve(TEST_APP_CHROME_EXT_DIR, ".ext-id");

let extensionId: string | undefined;
let sharedContext: BrowserContext | undefined;
let sharedUserDataDir: string | undefined;

export function readExtensionId(): string {
	if (!extensionId) {
		extensionId = readFileSync(EXT_ID_PATH, "utf8").trim();
		if (!extensionId) throw new Error(`empty .ext-id at ${EXT_ID_PATH}`);
	}
	return extensionId;
}

export function chromeExtBaseUrl(): string {
	return `chrome-extension://${readExtensionId()}/index.html`;
}

export async function ensureSharedChromeExtContext(): Promise<BrowserContext> {
	if (sharedContext) return sharedContext;
	sharedUserDataDir = await mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-chrome-ext-"));
	// `--headless=new` is the only headless mode that loads MV3 extensions
	// (Chrome 119+); the legacy headless ignores --load-extension.
	sharedContext = await chromium.launchPersistentContext(sharedUserDataDir, {
		headless: false,
		args: [
			`--disable-extensions-except=${DIST_PATH}`,
			`--load-extension=${DIST_PATH}`,
			"--headless=new",
			"--no-sandbox",
		],
	});
	return sharedContext;
}

export async function closeSharedChromeExtContext(): Promise<void> {
	if (sharedContext) {
		await sharedContext.close().catch(() => {});
		sharedContext = undefined;
	}
	if (sharedUserDataDir) {
		await rm(sharedUserDataDir, { recursive: true, force: true });
		sharedUserDataDir = undefined;
	}
}

export interface ChromeExtHarnessPage {
	page: Page;
	close: () => Promise<void>;
}

export async function launchChromeExtHarnessPage(opts: HarnessSetupOptions): Promise<ChromeExtHarnessPage> {
	const context = await ensureSharedChromeExtContext();
	const page = await context.newPage();
	await runHarnessSetupOnPage(page, opts, {
		readyTimeoutMs: 30_000,
		logPrefix: "ext page",
		debugEnvVar: "BODHI_PI_E2E_CHROME_EXT_DEBUG",
	});
	return {
		page,
		close: async () => {
			await page.close().catch(() => {});
		},
	};
}
