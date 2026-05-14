import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { MODEL_CONFIG_ID } from "@/wire/constants.js";
import type { ModelConfigState, ModelOption } from "./types.js";

export function flattenModelOptions(option: SessionConfigOption | undefined): ModelOption[] {
	if (!option || option.type !== "select") return [];
	const out: ModelOption[] = [];
	for (const item of option.options ?? []) {
		if ("value" in item) {
			out.push({
				id: item.value,
				name: item.name ?? item.value,
				...(item.description !== undefined ? { description: item.description } : {}),
			});
			continue;
		}
		for (const child of item.options ?? []) {
			out.push({
				id: child.value,
				name: child.name ?? child.value,
				...(child.description !== undefined ? { description: child.description } : {}),
			});
		}
	}
	return out;
}

export function modelConfigFromOptions(options: readonly SessionConfigOption[] | undefined): ModelConfigState {
	const option = options?.find((o) => o.id === MODEL_CONFIG_ID);
	if (!option || option.type !== "select") return { currentModelId: "", models: [] };
	return {
		currentModelId: option.currentValue,
		models: flattenModelOptions(option),
		option,
	};
}
