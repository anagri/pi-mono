import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, writeFiles } from "./seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HTTP_DIR = path.resolve(here, "../../..");

export interface SpawnTestServerOptions {
	scenario?: string | string[];
	files?: Record<string, string>;
}

export interface TestServerHandle {
	/** Base URL with trailing slash, e.g. `http://localhost:47812/`. */
	url: string;
	port: number;
	workspaceDir: string;
	dataDir: string;
	cleanup: () => Promise<void>;
}

/**
 * Spawn a bodhi-pi-http child process bound to a fresh tmpdir + a fresh
 * workspace dir seeded from the requested scenario. Waits for the server
 * to print its actual port (`--port 0` binds random) and returns its base URL.
 *
 * The same process serves both /acp and the pre-built frontend at /. Tests
 * load the page via `page.goto(handle.url)` — no separate vite dev needed.
 */
export async function spawnTestServer(opts: SpawnTestServerOptions = {}): Promise<TestServerHandle> {
	const root = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-http-e2e-"));
	const dataDir = path.join(root, "data");
	const workspaceDir = path.join(root, "workspace");
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });

	const seedFiles: Record<string, string> = {};
	if (opts.scenario) {
		const names = Array.isArray(opts.scenario) ? opts.scenario : [opts.scenario];
		for (const name of names) Object.assign(seedFiles, loadScenario(name));
	}
	if (opts.files) Object.assign(seedFiles, opts.files);
	writeFiles(workspaceDir, seedFiles);

	const child: ChildProcess = spawn(
		"npx",
		["--no-install", "tsx", "src/server/index.ts", "--port", "0", "--workspace", workspaceDir, "--data-dir", dataDir],
		{
			cwd: HTTP_DIR,
			env: { ...process.env, NODE_ENV: "test" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	const port = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("bodhi-pi-http did not announce its port within 20s"));
		}, 20_000);
		let buf = "";
		const onData = (chunk: Buffer) => {
			buf += chunk.toString("utf8");
			const m = buf.match(/listening on http:\/\/localhost:(\d+)/);
			if (m) {
				clearTimeout(timer);
				child.stdout?.off("data", onData);
				resolve(Number(m[1]));
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[bodhi-pi-http] ${chunk}`));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`bodhi-pi-http exited early with code ${code}`));
		});
	});

	const cleanup = async () => {
		if (!child.killed) {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const onExit = () => resolve();
				child.once("exit", onExit);
				setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
					resolve();
				}, 2000);
			});
		}
		rmSync(root, { recursive: true, force: true });
	};

	return { url: `http://localhost:${port}/`, port, workspaceDir, dataDir, cleanup };
}
