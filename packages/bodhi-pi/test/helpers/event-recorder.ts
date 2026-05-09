import type { BodhiPiEvent, BodhiPiEventHandlers, BodhiPiEventType } from "@/index.js";

/**
 * Single source of truth for the 19-event lifecycle recorder used across
 * `bodhi-pi/test/*.test.ts` and `bodhi-pi/e2e/*.e2e.ts`. Mirrored at
 * `packages/bodhi-pi-cli/test/helpers/event-recorder.ts` so every layer
 * captures the full contract — no per-suite drift in which events are forwarded.
 *
 * Returns `{ log, handlers }`; pass `handlers` to `createTestHarness({
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
