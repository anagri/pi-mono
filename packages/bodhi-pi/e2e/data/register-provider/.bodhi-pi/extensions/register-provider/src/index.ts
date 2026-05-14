import type { ExtensionFactory } from "@bodhiapp/bodhi-pi";
import { getModel } from "@earendil-works/pi-ai";

const factory: ExtensionFactory = (pi) => {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error("register-provider: ANTHROPIC_API_KEY required");
	const model = getModel("anthropic", "claude-haiku-4-5-20251001");
	pi.registerProvider("ext-anthropic", { model, getApiKey: () => apiKey });
};

export default factory;
