import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ExtensionToolDefinition } from "./types.js";

/** Convert an extension's `ExtensionToolDefinition` to pi-agent-core's `AgentTool`. */
export function adaptExtensionTool<P extends TSchema, D>(def: ExtensionToolDefinition<P, D>): AgentTool<P, D> {
	return {
		name: def.name,
		label: def.name,
		description: def.description,
		parameters: def.parameters,
		execute: async (toolCallId, params, signal) => {
			const result = await def.execute(toolCallId, params, signal);
			return result;
		},
	};
}
