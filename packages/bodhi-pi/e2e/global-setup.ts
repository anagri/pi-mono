import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_ENV_VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_HTTP_BIN = path.resolve(here, "test-app-http/dist/test-app-http/src/server/index.js");

const DEFAULT_MODELS = "openai:gpt-4o-mini,openai:gpt-5-mini,anthropic:claude-haiku-4-5";
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

	return async () => {
		for (const inst of [http, ws]) {
			try {
				inst.child.kill("SIGTERM");
			} catch {
				// already exited
			}
		}
		await Promise.all([
			rm(http.dataDir, { recursive: true, force: true }),
			rm(ws.dataDir, { recursive: true, force: true }),
		]);
	};
}
