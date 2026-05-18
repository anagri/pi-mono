import {
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";

export type ParentTurn = { tool: string; args: Record<string, unknown> } | { text: string };

export interface SubagentRunScript {
	parentTurns?: ParentTurn[];
	childResponses?: FauxResponseStep[];
	finalText?: string;
}

export function scriptSubagentRun(faux: FauxProviderRegistration, script: SubagentRunScript): void {
	const queue: FauxResponseStep[] = [];
	for (const turn of script.parentTurns ?? []) {
		if ("tool" in turn) {
			queue.push(fauxAssistantMessage([fauxToolCall(turn.tool, turn.args)], { stopReason: "toolUse" }));
		} else {
			queue.push(fauxAssistantMessage(turn.text));
		}
	}
	for (const r of script.childResponses ?? []) queue.push(r);
	if (script.finalText !== undefined) queue.push(fauxAssistantMessage(script.finalText));
	faux.setResponses(queue);
}
