import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ExtensionToolDefinition } from "./types.js";

/**
 * Convert an extension's `ExtensionToolDefinition` to pi-agent-core's `AgentTool`. The thin
 * `async` wrapper around `def.execute` is intentional: extensions may return either
 * `AgentToolResult` or `Promise<AgentToolResult>`, while `AgentTool.execute` strictly requires a
 * Promise — `async` adapts both shapes.
 */
export function adaptExtensionTool<P extends TSchema, D>(def: ExtensionToolDefinition<P, D>): AgentTool<P, D> {
	return {
		name: def.name,
		label: def.name,
		description: def.description,
		parameters: def.parameters,
		execute: async (toolCallId, params, signal, onUpdate) => def.execute(toolCallId, params, signal, onUpdate),
	};
}
