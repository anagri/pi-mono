import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME_EXT_DIR = path.resolve(here, "..", "e2e", "test-app-chrome-ext");

const REQUIRED = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

export default async function globalSetup(): Promise<void> {
	loadEnv({ path: path.join(here, "..", "e2e", ".env.test") });
	const missing = REQUIRED.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required env vars for bodhi-pi e2e-ui: ${missing.join(", ")}. ` +
				`Add them to packages/bodhi-pi/e2e/.env.test.`,
		);
	}
	await runBuild(CHROME_EXT_DIR);
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
