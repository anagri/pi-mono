import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeSharedBrowser, ensureSharedBrowser } from "./helpers/browser/launch.js";
import { waitForViteReady } from "./helpers/browser/wait-for-vite.js";
import {
	chromeExtBaseUrl,
	closeSharedChromeExtContext,
	ensureSharedChromeExtContext,
} from "./helpers/chrome-ext/launch.js";

const REQUIRED_ENV_VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_HTTP_BIN = path.resolve(here, "..", "test-apps", "http", "dist", "index.js");
const TEST_APP_BROWSER_DIR = path.resolve(here, "..", "test-apps", "browser");
const BROWSER_VITE_PORT = 35273;

const DEFAULT_MODELS = "openai:gpt-4o-mini,openai:gpt-5-mini,anthropic:claude-haiku-4-5-20251001";
const DEFAULT_MODEL = "gpt-4o-mini";

async function waitForListening(child: ChildProcess, timeoutMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error(`test-app-http did not bind within ${timeoutMs}ms`)), timeoutMs);
		const onData = (chunk: Buffer | string) => {
			buf += chunk.toString();
			const match = buf.match(/listening on http:\/\/localhost:(\d+)/);
			if (match) {
				clearTimeout(timer);
				child.stdout?.off("data", onData);
				resolve(Number(match[1]));
			}
		};
		child.stdout?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`test-app-http exited before binding (code=${code})`));
		});
	});
}

async function spawnVitePreview(): Promise<ChildProcess> {
	// Serve the prebuilt `dist/public/` (built by the test:e2e prepare step)
	// in production mode. Avoids the dev-mode react-refresh plugin which
	// trips over the Worker entry under Vite 8/rolldown.
	const child = spawn("npx", ["vite", "preview", "--port", String(BROWSER_VITE_PORT), "--strictPort"], {
		cwd: TEST_APP_BROWSER_DIR,
		stdio: ["ignore", "pipe", "inherit"],
		env: { ...process.env, FORCE_COLOR: "0" },
	});
	await waitForViteReady(child, 30_000);
	return child;
}

async function spawnMcpEverythingHttp(port: number): Promise<ChildProcess> {
	const child = spawn("npx", ["--yes", "@modelcontextprotocol/server-everything", "streamableHttp"], {
		env: { ...process.env, PORT: String(port), FORCE_COLOR: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await new Promise<void>((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error(`mcp-everything did not bind within 30000ms`)), 30_000);
		const onData = (chunk: Buffer | string) => {
			buf += chunk.toString();
			if (/listening on port/i.test(buf)) {
				clearTimeout(timer);
				resolve();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`mcp-everything exited before binding (code=${code}); buf=${buf.slice(0, 200)}`));
		});
	});
	// Keep draining stdio so the child doesn't block on backpressure for the rest of the run.
	child.stdout?.on("data", () => {});
	child.stderr?.on("data", () => {});
	return child;
}

async function spawnTestAppHttp(label: string): Promise<{ child: ChildProcess; port: number; dataDir: string }> {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), `bodhi-pi-e2e-${label}-`));
	const child = spawn(
		"node",
		[
			TEST_APP_HTTP_BIN,
			"--port",
			"0",
			"--data-dir",
			dataDir,
			"--models",
			DEFAULT_MODELS,
			"--default-model",
			DEFAULT_MODEL,
		],
		{
			stdio: ["ignore", "pipe", "inherit"],
			env: { ...process.env },
		},
	);
	const port = await waitForListening(child, 15_000);
	return { child, port, dataDir };
}

export async function setup(): Promise<() => Promise<void>> {
	const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required env vars for bodhi-pi e2e: ${missing.join(", ")}. ` +
				`Set them in packages/bodhi-pi/e2e/.env.test (see .env.test.example).`,
		);
	}

	// Vitest's projects mode invokes each project's globalSetup independently;
	// the same env vars + spawned processes would race across projects. Bail
	// out if a prior project's setup has already populated the env so the
	// shared test-app instances (test-app-http × 2, vite preview, chromium,
	// mcp-everything) boot once for the entire run.
	if (process.env.BODHI_PI_E2E_BROWSER_BASE_URL) {
		return async () => {};
	}

	// Shared mcp-everything instance (http-streamable) for MCP e2e across all
	// runtimes. Single port reused; tests slug-collision-resolve to keep slugs
	// unique within each session.
	const MCP_EVERYTHING_PORT = 33345;
	const mcpEverything = await spawnMcpEverythingHttp(MCP_EVERYTHING_PORT);
	process.env.BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL = `http://localhost:${MCP_EVERYTHING_PORT}/mcp`;

	// Two shared test-app-http instances for the run: one for the |http| project
	// (per-turn agent rebuild over HTTP+SSE on /acp) and one for the |ws| project
	// (stateful per-connection agent over WebSocket on /acp-ws). Separate ports +
	// dataDirs keep the two transports' SQLite/workspace state cleanly isolated.
	const http = await spawnTestAppHttp("http");
	process.env.BODHI_PI_E2E_HTTP_BASE_URL = `http://localhost:${http.port}`;
	process.env.BODHI_PI_E2E_HTTP_DATA_DIR = http.dataDir;

	const ws = await spawnTestAppHttp("ws");
	process.env.BODHI_PI_E2E_WS_BASE_URL = `http://localhost:${ws.port}`;
	process.env.BODHI_PI_E2E_WS_DATA_DIR = ws.dataDir;

	// Vite preview for the prebuilt test-app-browser + headless chromium for
	// the browser project's harness. Both shared across all browser-runtime
	// harnesses; per-test isolation comes from browser.newContext() +
	// per-test Dexie dbName suffix in the page.
	const viteChild = await spawnVitePreview();
	process.env.BODHI_PI_E2E_BROWSER_BASE_URL = `http://localhost:${BROWSER_VITE_PORT}`;
	await ensureSharedBrowser();

	// Persistent chromium context for the chrome-ext project — loads the
	// unpacked test-app-chrome-ext dist/ via --load-extension. Sibling to the
	// browser project's regular chromium singleton (different launch mode).
	await ensureSharedChromeExtContext();
	process.env.BODHI_PI_E2E_CHROME_EXT_BASE_URL = chromeExtBaseUrl();

	return async () => {
		for (const inst of [http, ws]) {
			try {
				inst.child.kill("SIGTERM");
			} catch {
				// already exited
			}
		}
		try {
			viteChild.kill("SIGTERM");
		} catch {
			// already exited
		}
		try {
			mcpEverything.kill("SIGTERM");
		} catch {
			// already exited
		}
		await closeSharedBrowser();
		await closeSharedChromeExtContext();
		await Promise.all([
			rm(http.dataDir, { recursive: true, force: true }),
			rm(ws.dataDir, { recursive: true, force: true }),
		]);
	};
}
