import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import { envKeysFor } from "./api-keys.js";

const SUBAGENT_PROVIDER = "openrouter" as const;
const SUBAGENT_MODEL_ID = "anthropic/claude-haiku-4.5" as const;

export function subagentModel(): Model<Api> {
	const model = getModel(SUBAGENT_PROVIDER, SUBAGENT_MODEL_ID);
	if (!model) {
		throw new Error(`subagent test model not in pi-ai registry: ${SUBAGENT_PROVIDER}:${SUBAGENT_MODEL_ID}`);
	}
	return model;
}

export const subagentApiKey = envKeysFor(SUBAGENT_PROVIDER);
