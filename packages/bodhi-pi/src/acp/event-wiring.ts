import type { AgentSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { BodhiPiLogger } from "@/acp/agent.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import type { SessionState } from "@/sessions/session-state.js";
import { LIFECYCLE_EVENT_METHOD } from "@/wire/constants.js";

export interface EventWiringDeps {
	events: EventDispatcher;
	conn: AgentSideConnection;
	sessions: Map<string, SessionState>;
	buildAllConfigOptions: (sessionId: string) => Promise<SessionConfigOption[]>;
	logger: BodhiPiLogger;
}

/**
 * Single translation surface from internal `EventDispatcher` events to ACP wire notifications.
 * Services that need to push wire-level signals emit a domain event; this module translates
 * them. No service should call `conn.sessionUpdate` / `conn.notification` directly for events
 * that have a domain shape — keep the translation here so SDK extraction can stub one module.
 *
 * Two translation families today:
 *   1. State-change events (auth, settings, model, mode) → `config_option_update`.
 *   2. MCP / sub-agent lifecycle events → `LIFECYCLE_EVENT_METHOD` notification (Client status panel).
 */
export function wireInternalEventHandlers(deps: EventWiringDeps): void {
	const { events, conn, sessions, buildAllConfigOptions, logger } = deps;
	const emitUpdate = async (sessionId: string) => {
		if (!sessions.has(sessionId)) return;
		const configOptions = await buildAllConfigOptions(sessionId);
		await conn.sessionUpdate({
			sessionId,
			update: { sessionUpdate: "config_option_update", configOptions },
		});
	};

	events.appendHandlers("auth_change", [
		async (e) => {
			if (e.sessionId !== undefined) await emitUpdate(e.sessionId);
		},
	]);
	events.appendHandlers("settings_change", [
		async (e) => {
			if (affectsPickerKey(e.key)) await emitUpdate(e.sessionId);
		},
	]);
	events.appendHandlers("model_select", [
		async (e) => {
			await emitUpdate(e.sessionId);
		},
	]);
	events.appendHandlers("mode_change", [
		async (e) => {
			await emitUpdate(e.sessionId);
		},
	]);

	const notifyLifecycle = async (params: Record<string, unknown>): Promise<void> => {
		try {
			await conn.extNotification(LIFECYCLE_EVENT_METHOD, params);
		} catch (err) {
			logger.error("[bodhi-pi] lifecycle notify failed:", err);
		}
	};
	events.appendHandlers("mcp_status_change", [(e) => notifyLifecycle(e as unknown as Record<string, unknown>)]);
	events.appendHandlers("mcp_tools_change", [(e) => notifyLifecycle(e as unknown as Record<string, unknown>)]);
	events.appendHandlers("mcp_oauth_status_change", [(e) => notifyLifecycle(e as unknown as Record<string, unknown>)]);
	events.appendHandlers("subagent_start", [(e) => notifyLifecycle(e as unknown as Record<string, unknown>)]);
	events.appendHandlers("subagent_end", [(e) => notifyLifecycle(e as unknown as Record<string, unknown>)]);
	events.appendHandlers("tool_blocked", [(e) => notifyLifecycle(e as unknown as Record<string, unknown>)]);
	events.appendHandlers("tool_approval_request", [(e) => notifyLifecycle(e as unknown as Record<string, unknown>)]);
	events.appendHandlers("tool_approval_response", [(e) => notifyLifecycle(e as unknown as Record<string, unknown>)]);
}

/** Dotted-key paths whose changes reshape the model picker advertised in `configOptions`. */
function affectsPickerKey(key: string): boolean {
	return (
		key === "defaultModelId" ||
		key.startsWith("defaultModelId.") ||
		// Legacy alias — kept for back-compat with settings files written before D6 rename.
		key === "defaultModel" ||
		key.startsWith("defaultModel.") ||
		key === "defaultThinkingLevel" ||
		key.startsWith("defaultThinkingLevel.") ||
		key === "defaultMode" ||
		key.startsWith("defaultMode.")
	);
}
