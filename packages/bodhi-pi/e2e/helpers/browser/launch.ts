import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type HarnessSetupOptions, runHarnessSetupOnPage } from "./page-setup.js";

// Singleton headless chromium shared across the whole vitest run. Created in
// global-setup.ts; reused by every browser-runtime harness instance. Per-test
// isolation comes from `browser.newContext()` (fresh IndexedDB origin) plus a
// per-test (userId, email) Dexie dbName suffix.

let sharedBrowser: Browser | undefined;

export async function ensureSharedBrowser(): Promise<Browser> {
	if (!sharedBrowser) {
		sharedBrowser = await chromium.launch({ headless: true });
	}
	return sharedBrowser;
}

export async function closeSharedBrowser(): Promise<void> {
	if (sharedBrowser) {
		await sharedBrowser.close();
		sharedBrowser = undefined;
	}
}

export interface HarnessContext {
	context: BrowserContext;
	page: Page;
	close: () => Promise<void>;
}

export async function launchHarnessContext(opts: HarnessSetupOptions): Promise<HarnessContext> {
	const browser = await ensureSharedBrowser();
	const context = await browser.newContext();
	const page = await context.newPage();
	await runHarnessSetupOnPage(page, opts, {
		readyTimeoutMs: 15_000,
		logPrefix: "page",
		debugEnvVar: "BODHI_PI_E2E_BROWSER_DEBUG",
		forwardResponses: true,
	});
	return {
		context,
		page,
		close: async () => {
			await context.close();
		},
	};
}
