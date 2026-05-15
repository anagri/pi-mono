import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME_EXT_DIR = path.resolve(here, "..", "test-apps", "chrome-ext");

const REQUIRED = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const MCP_EVERYTHING_PORT = 33346;

let mcpEverythingChild: ChildProcess | undefined;

export default async function globalSetup(): Promise<() => Promise<void>> {
	loadEnv({ path: path.join(here, "..", "e2e", ".env.test") });
	const missing = REQUIRED.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required env vars for bodhi-pi e2e-ui: ${missing.join(", ")}. ` +
				`Add them to packages/bodhi-pi/e2e/.env.test.`,
		);
	}
	await runBuild(CHROME_EXT_DIR);
	mcpEverythingChild = await spawnMcpEverythingHttp(MCP_EVERYTHING_PORT);
	process.env.BODHI_PI_E2E_UI_MCP_EVERYTHING_HTTP_URL = `http://localhost:${MCP_EVERYTHING_PORT}/mcp`;
	return async () => {
		try {
			mcpEverythingChild?.kill("SIGTERM");
		} catch {}
	};
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
	child.stdout?.on("data", () => {});
	child.stderr?.on("data", () => {});
	return child;
}

async function runBuild(cwd: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("npm", ["run", "build"], { cwd, stdio: "inherit" });
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`npm run build failed in ${cwd} (exit ${code})`));
		});
		child.once("error", reject);
	});
}
