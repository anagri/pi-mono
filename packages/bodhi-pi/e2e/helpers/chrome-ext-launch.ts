import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type BrowserContext, chromium, type Page } from "playwright";

// Singleton persistent context for the whole vitest run. MV3 extensions
// require `chromium.launchPersistentContext` (regular launch + newContext
// can't host an unpacked extension), so we boot one persistent profile in
// a fresh tmpdir, share it across all chrome-ext harnesses, and rely on
// the per-test random userId to namespace each test's Dexie dbName.

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CHROME_EXT_DIR = path.resolve(here, "../test-app-chrome-ext");
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

export interface LaunchChromeExtHarnessPageOptions {
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

export interface ChromeExtHarnessPage {
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

export async function launchChromeExtHarnessPage(
	opts: LaunchChromeExtHarnessPageOptions,
): Promise<ChromeExtHarnessPage> {
	const context = await ensureSharedChromeExtContext();
	const page = await context.newPage();
	const debug = process.env.BODHI_PI_E2E_CHROME_EXT_DEBUG === "1";
	page.on("console", (msg) => {
		if (debug || msg.type() === "error" || msg.type() === "warning" || msg.type() === "log") {
			process.stderr.write(`[ext page ${msg.type()}] ${msg.text()}\n`);
		}
	});
	page.on("pageerror", (err) => {
		process.stderr.write(`[ext page error] ${err.message}\n${err.stack ?? ""}\n`);
	});
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
	await page.waitForSelector('[data-testid="test-app-root"][data-test-state="ready"]', { timeout: 30_000 });

	return {
		page,
		close: async () => {
			await page.close().catch(() => {});
		},
	};
}
