import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";

/**
 * Script a faux provider to emit one tool call followed by a "done" message.
 * The provider needs to receive both responses up-front because pi-agent-core
 * makes a second LLM call after the tool result.
 */
export function scriptToolThenDone(
	faux: FauxProviderRegistration,
	toolName: string,
	args: Record<string, unknown>,
): void {
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
}
