// Build a `(provider) => apiKey | undefined` lookup over the requested
// providers, reading from process.env. global-setup.ts gates the env vars at
// run start, so the `!` assertion is sound at test time.

type KnownProvider = "openai" | "anthropic";

const ENV_VAR: Record<KnownProvider, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
};

export function envKeysFor(...providers: KnownProvider[]): (provider: string) => string | undefined {
	const want = new Set<string>(providers);
	return (provider: string): string | undefined => {
		if (!want.has(provider)) return undefined;
		// global-setup.ts gates the env vars upfront, so the lookup is sound at
		// test time even though TypeScript can't see the gate.
		return process.env[ENV_VAR[provider as KnownProvider]];
	};
}
