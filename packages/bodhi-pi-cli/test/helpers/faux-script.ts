import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";

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
