import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(here, "../..");

/**
 * Build the frontend once before any spec runs (each spawned server serves it)
 * and fail-fast if any required API key is missing. Fail-fast — not skip — is
 * the policy for parity-host e2e: a missing key is a setup error, not a test
 * the runner should silently elide. Mirrors `bodhi-pi-ws-frontend/e2e/global-setup.ts`.
 */
async function globalSetup(): Promise<void> {
	const required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
	const missing = required.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required env vars for bodhi-pi-http e2e: ${missing.join(", ")}. ` +
				`Set them in packages/bodhi-pi-http/.env or .env.test.`,
		);
	}

	const indexHtml = path.join(PKG_ROOT, "dist", "public", "index.html");
	const force = process.env.BODHI_PI_HTTP_E2E_REBUILD === "1";
	if (!force && existsSync(indexHtml)) return;
	process.stdout.write("[bodhi-pi-http e2e] building frontend...\n");
	execSync("npx --no-install vite build", { cwd: PKG_ROOT, stdio: "inherit" });
}

export default globalSetup;
