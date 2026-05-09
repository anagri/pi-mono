import { type Api, getModel, type Model } from "@mariozechner/pi-ai";

const PROVIDER_KEY_ENV: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
};

export interface ModelsResolution {
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
}

/**
 * Read models from environment. Always includes openai/gpt-4o-mini when
 * OPENAI_API_KEY is set. Falls back to throwing when no providers are configured.
 */
export function resolveModelsFromEnv(): ModelsResolution {
	const models: Model<Api>[] = [];
	if (process.env.OPENAI_API_KEY) {
		models.push(getModel("openai", "gpt-4o-mini"));
	}
	if (process.env.ANTHROPIC_API_KEY) {
		models.push(getModel("anthropic", "claude-3-5-haiku-latest"));
	}
	if (models.length === 0) {
		throw new Error("No model providers configured. Set OPENAI_API_KEY (and/or ANTHROPIC_API_KEY) in .env.");
	}
	return {
		models,
		defaultModelId: models[0].id,
		getApiKey: (provider) => {
			const envName = PROVIDER_KEY_ENV[provider];
			return envName ? process.env[envName] : undefined;
		},
	};
}
