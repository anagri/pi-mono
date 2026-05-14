import type { Api, Model } from "@earendil-works/pi-ai";
import type { Page } from "playwright";
import { buildSeedXml } from "./seed-xml.js";

// Shared goto → wait-needs-init → fill fields → submit → wait-ready flow used by
// both the browser-runtime page (Vite preview) and the chrome-ext-runtime page
// (unpacked extension). The contract is the test-app's `data-testid` selectors;
// runtime-specific differences are captured in `RunHarnessSetupConfig` so the
// flow itself stays single-source.

export interface HarnessSetupOptions {
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

export interface RunHarnessSetupConfig {
	/** Selector wait timeout for `data-test-state="ready"`. Browser fits 15s; chrome-ext needs 30s for the persistent context. */
	readyTimeoutMs: number;
	/** Prefix for page-console/error stderr forwarding. e.g. "page", "ext page". */
	logPrefix: string;
	/** Env var read for routine-log debug toggle. e.g. "BODHI_PI_E2E_BROWSER_DEBUG". */
	debugEnvVar: string;
	/** Whether to forward 4xx/5xx HTTP responses to stderr. Browser does; chrome-ext does not (chrome-extension:// URLs aren't HTTP). */
	forwardResponses?: boolean;
}

export async function runHarnessSetupOnPage(
	page: Page,
	opts: HarnessSetupOptions,
	cfg: RunHarnessSetupConfig,
): Promise<void> {
	const debug = process.env[cfg.debugEnvVar] === "1";
	page.on("console", (msg) => {
		if (debug || msg.type() === "error" || msg.type() === "warning" || msg.type() === "log") {
			process.stderr.write(`[${cfg.logPrefix} ${msg.type()}] ${msg.text()}\n`);
		}
	});
	page.on("pageerror", (err) => {
		process.stderr.write(`[${cfg.logPrefix} error] ${err.message}\n${err.stack ?? ""}\n`);
	});
	if (cfg.forwardResponses) {
		page.on("response", (res) => {
			if (res.status() >= 400) {
				process.stderr.write(`[${cfg.logPrefix} response] ${res.status()} ${res.url()}\n`);
			}
		});
	}
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
	await page.waitForSelector('[data-testid="test-app-root"][data-test-state="ready"]', {
		timeout: cfg.readyTimeoutMs,
	});
}
