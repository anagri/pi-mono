import type { Api, Model } from "@earendil-works/pi-ai";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

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

export interface LaunchHarnessContextOptions {
	baseUrl: string;
	userId: string;
	userEmail: string;
	seedFiles?: Record<string, string>;
	models?: Model<Api>[];
	defaultModelId?: string;
	apiKeys?: Record<string, string>;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	homeDir?: string;
}

export interface HarnessContext {
	context: BrowserContext;
	page: Page;
	close: () => Promise<void>;
}

function buildSeedXml(seedFiles: Record<string, string>): string {
	if (Object.keys(seedFiles).length === 0) return "";
	const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const xmlEscapeAttr = (s: string) => xmlEscape(s).replace(/"/g, "&quot;");
	const lines = ["<files>"];
	for (const [p, content] of Object.entries(seedFiles)) {
		lines.push(`<file path="${xmlEscapeAttr(p)}">${xmlEscape(content)}</file>`);
	}
	lines.push("</files>");
	return lines.join("\n");
}

export async function launchHarnessContext(opts: LaunchHarnessContextOptions): Promise<HarnessContext> {
	const browser = await ensureSharedBrowser();
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(opts.baseUrl, { waitUntil: "domcontentloaded" });
	await page.waitForSelector('[data-testid="test-app-root"][data-test-state="needs-init"]');

	await page.fill('[data-testid="user-id"]', opts.userId);
	await page.fill('[data-testid="user-email"]', opts.userEmail);
	if (opts.seedFiles && Object.keys(opts.seedFiles).length > 0) {
		await page.fill('[data-testid="seed-files"]', buildSeedXml(opts.seedFiles));
	}
	const config: Record<string, unknown> = {};
	if (opts.models && opts.models.length > 0) config.models = opts.models;
	if (opts.defaultModelId !== undefined) config.defaultModelId = opts.defaultModelId;
	if (opts.apiKeys) config.apiKeys = opts.apiKeys;
	if (opts.systemPrompt !== undefined) config.systemPrompt = opts.systemPrompt;
	if (opts.appendSystemPrompt !== undefined) config.appendSystemPrompt = opts.appendSystemPrompt;
	if (opts.homeDir !== undefined) config.homeDir = opts.homeDir;
	await page.fill('[data-testid="config"]', JSON.stringify(config));

	await page.click('[data-testid="setup-submit"]');
	await page.waitForSelector('[data-testid="test-app-root"][data-test-state="ready"]', { timeout: 15_000 });

	return {
		context,
		page,
		close: async () => {
			await context.close();
		},
	};
}
