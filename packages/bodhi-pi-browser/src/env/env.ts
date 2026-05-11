import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";

/**
 * Resolved env for a browser host. The host injects a `getEnvVar` so each host
 * can source from whatever env mechanism it has (e.g. `import.meta.env.VITE_*`
 * for Vite-built hosts). The shared package never reaches into Vite globals.
 */
export interface ResolvedEnv {
	apiKeys: Record<string, string>;
	models: Model<Api>[];
	defaultModelId: string;
}

const PROVIDER_KEY_MAP: Record<string, string> = {
	openai: "VITE_OPENAI_API_KEY",
	anthropic: "VITE_ANTHROPIC_API_KEY",
	google: "VITE_GEMINI_API_KEY",
};

export function buildResolvedEnv(getEnvVar: (key: string) => string | undefined): ResolvedEnv {
	const apiKeys: Record<string, string> = {};
	for (const [provider, viteKey] of Object.entries(PROVIDER_KEY_MAP)) {
		const value = getEnvVar(viteKey);
		if (typeof value === "string" && value.length > 0) {
			apiKeys[provider] = value;
		}
	}

	// Default registry: two OpenAI models. Anthropic registers as a switch
	// target only when its key is present.
	const models: Model<Api>[] = [
		getModel("openai", "gpt-4o-mini") as Model<Api>,
		getModel("openai", "gpt-4o") as Model<Api>,
	];
	if (apiKeys.anthropic) {
		models.push(getModel("anthropic", "claude-haiku-4-5") as Model<Api>);
	}
	const defaultModelId = "gpt-4o-mini";

	return { apiKeys, models, defaultModelId };
}
