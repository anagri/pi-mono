import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

export default async function globalSetup(): Promise<void> {
	loadEnv({ path: path.join(here, "..", ".env.test") });
	const missing = REQUIRED.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required env vars for bodhi-pi-web e2e: ${missing.join(", ")}. ` +
				`Add them to packages/bodhi-pi-web/.env.test (mirror of packages/bodhi-pi-cli/.env.test).`,
		);
	}
}
