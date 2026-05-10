async function globalSetup(): Promise<void> {
	const required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
	const missing = required.filter((k) => !process.env[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required env vars for ws-frontend e2e: ${missing.join(", ")}. ` +
				`Set them in packages/bodhi-pi-ws-server/.env or packages/bodhi-pi-ws-frontend/e2e/.env.test.`,
		);
	}
}

export default globalSetup;
