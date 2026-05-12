// Required env vars for the consolidated e2e suite. Listed in one place so the
// gate fails fast at startup rather than per-test, and tests can assume
// `process.env.NAME!` is set without re-checking.
const REQUIRED_ENV_VARS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

export function setup(): void {
	const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required env vars for bodhi-pi e2e: ${missing.join(", ")}. ` +
				`Set them in packages/bodhi-pi/e2e/.env.test (see .env.test.example).`,
		);
	}
}
