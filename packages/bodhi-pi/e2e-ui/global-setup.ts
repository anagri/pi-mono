import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { type AuthMcpServerHandle, spawnAuthMcpServer } from "../e2e/helpers/auth-mcp-server.ts";
import { type OAuthMcpServerHandle, spawnOAuthMcpServer } from "../e2e/helpers/oauth-mcp-server.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME_EXT_DIR = path.resolve(here, "..", "test-apps", "chrome-ext");

const REQUIRED = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const MCP_EVERYTHING_PORT = 33346;
const AUTH_MCP_PORT = 33347;
const AUTH_MCP_TOKEN = "e2e-ui-test-bearer-token-7y3";
const OAUTH_MCP_PORT = 33348;

let mcpEverythingChild: ChildProcess | undefined;
let authMcp: AuthMcpServerHandle | undefined;
let oauthMcp: OAuthMcpServerHandle | undefined;

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
	authMcp = await spawnAuthMcpServer(AUTH_MCP_PORT, AUTH_MCP_TOKEN);
	process.env.BODHI_PI_E2E_UI_MCP_AUTH_HTTP_URL = authMcp.url;
	process.env.BODHI_PI_E2E_UI_MCP_AUTH_TOKEN = AUTH_MCP_TOKEN;
	oauthMcp = await spawnOAuthMcpServer({ port: OAUTH_MCP_PORT });
	process.env.BODHI_PI_E2E_UI_OAUTH_MCP_URL = oauthMcp.mcpUrl;
	process.env.BODHI_PI_E2E_UI_OAUTH_AUTHORIZE_URL = oauthMcp.authorizeUrl;
	process.env.BODHI_PI_E2E_UI_OAUTH_TOKEN_URL = oauthMcp.tokenUrl;
	process.env.BODHI_PI_E2E_UI_OAUTH_REGISTRATION_URL = oauthMcp.registrationEndpoint;
	process.env.BODHI_PI_E2E_UI_OAUTH_CLIENT_ID = oauthMcp.clientId;
	process.env.BODHI_PI_E2E_UI_OAUTH_CLIENT_SECRET = oauthMcp.clientSecret;
	return async () => {
		try {
			mcpEverythingChild?.kill("SIGTERM");
		} catch {}
		try {
			await authMcp?.close();
		} catch {}
		try {
			await oauthMcp?.close();
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
