import type { Api, Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";

/**
 * Resolved env for the bodhi-pi-web host. `import.meta.env.VITE_*` are the only
 * vars Vite exposes to client bundles. We map provider name (used by pi-ai) to
 * the `VITE_<PROVIDER>_API_KEY` we expect to find in `.env`.
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

export function readEnv(): ResolvedEnv {
	const apiKeys: Record<string, string> = {};
	for (const [provider, viteKey] of Object.entries(PROVIDER_KEY_MAP)) {
		const value = import.meta.env[viteKey];
		if (typeof value === "string" && value.length > 0) {
			apiKeys[provider] = value;
		}
	}

	// M3 hardcodes a single model. M4 widens the registry.
	const models: Model<Api>[] = [getModel("openai", "gpt-4o-mini") as Model<Api>];
	const defaultModelId = "gpt-4o-mini";

	return { apiKeys, models, defaultModelId };
}
