import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, writeFiles } from "./seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WS_SERVER_DIR = path.resolve(here, "../../../bodhi-pi-ws-server");

export interface SpawnTestServerOptions {
	/** Scenario directory under `e2e/data/<scenario>/` to materialize as the workspace. */
	scenario?: string;
	/** Inline files on top of the loaded scenario. Path keys begin with `/`. */
	files?: Record<string, string>;
}

export interface TestServerHandle {
	url: string;
	port: number;
	workspaceDir: string;
	dataDir: string;
	cleanup: () => Promise<void>;
}

/**
 * Spawn a ws-server child process bound to a fresh tmpdir + a fresh workspace
 * dir seeded from the requested scenario. Waits for the server to print its
 * actual port (`--port 0` binds random) and returns the WS URL.
 *
 * Each test owns the lifecycle: call `cleanup()` to terminate the child and
 * delete the tmpdirs.
 */
export async function spawnTestServer(opts: SpawnTestServerOptions = {}): Promise<TestServerHandle> {
	const root = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-ws-e2e-"));
	const dataDir = path.join(root, "data");
	const workspaceDir = path.join(root, "workspace");

	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	const seedFiles: Record<string, string> = {};
	if (opts.scenario) Object.assign(seedFiles, loadScenario(opts.scenario));
	if (opts.files) Object.assign(seedFiles, opts.files);
	writeFiles(workspaceDir, seedFiles);

	const child: ChildProcess = spawn(
		"npx",
		["--no-install", "tsx", "src/index.ts", "--port", "0", "--workspace", workspaceDir, "--data-dir", dataDir],
		{
			cwd: WS_SERVER_DIR,
			env: { ...process.env, NODE_ENV: "test" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	const port = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("ws-server did not announce its port within 20s"));
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
		child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[ws-server] ${chunk}`));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`ws-server exited early with code ${code}`));
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

	return { url: `ws://localhost:${port}/agent`, port, workspaceDir, dataDir, cleanup };
}
