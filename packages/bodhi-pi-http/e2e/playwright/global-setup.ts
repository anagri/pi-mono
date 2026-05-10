import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(here, "../..");

/**
 * Build the frontend before any spec runs. Each spawned bodhi-pi-http server
 * serves `dist/public/` from the package root, so this single build covers
 * every per-test spawn.
 *
 * If `dist/public/index.html` already exists and BODHI_PI_HTTP_E2E_REBUILD is
 * unset, we skip — fast iteration during local dev. CI sets the flag to force
 * a rebuild every run.
 */
async function globalSetup(): Promise<void> {
	const indexHtml = path.join(PKG_ROOT, "dist", "public", "index.html");
	const force = process.env.BODHI_PI_HTTP_E2E_REBUILD === "1";
	if (!force && existsSync(indexHtml)) return;
	process.stdout.write("[bodhi-pi-http e2e] building frontend...\n");
	execSync("npx --no-install vite build", { cwd: PKG_ROOT, stdio: "inherit" });
}

export default globalSetup;
