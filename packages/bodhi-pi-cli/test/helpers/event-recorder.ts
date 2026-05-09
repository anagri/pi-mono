import type { BodhiPiEvent, BodhiPiEventHandlers, BodhiPiEventType } from "@bodhiapp/bodhi-pi";

/**
 * Single source of truth for the 19-event lifecycle recorder used across
 * `bodhi-pi-cli/e2e/`. Mirrors `bodhi-pi/test/helpers/event-recorder.ts`
 * (slated by the May-09 core review C.1) so e2e at every layer captures the
 * full contract — no per-spec drift in which events are forwarded.
 *
 * Returns `{ log, handlers }`; pass `handlers` to `createCliTestHarness({
 * eventHandlers })` and read `log` after the run.
 */
export const ALL_EVENT_TYPES: readonly BodhiPiEventType[] = [
	"session_start",
	"session_shutdown",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"input",
	"before_agent_start",
	"before_provider_request",
	"after_provider_response",
	"tool_call",
	"tool_result",
	"model_select",
] as const;

export interface EventRecorder {
	log: BodhiPiEvent[];
	handlers: BodhiPiEventHandlers;
}

export function recorder(): EventRecorder {
	const log: BodhiPiEvent[] = [];
	const push = (e: BodhiPiEvent) => void log.push(e);
	const handlers: BodhiPiEventHandlers = {};
	for (const t of ALL_EVENT_TYPES) {
		(handlers as Record<string, Array<(e: BodhiPiEvent) => void>>)[t] = [push];
	}
	return { log, handlers };
}
