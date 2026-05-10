export function setup(): void {
	const required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
	const missing = required.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required env vars for e2e: ${missing.join(", ")}. ` +
				`Set them in packages/bodhi-pi-cli/e2e/.env.test.`,
		);
	}
}
