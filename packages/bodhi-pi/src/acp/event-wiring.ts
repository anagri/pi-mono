import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { EventDispatcher } from "@/events/dispatcher.js";
import type { ModelRegistry } from "@/models/registry.js";
import type { SessionState } from "@/sessions/session-state.js";

export interface EventWiringDeps {
	events: EventDispatcher;
	conn: AgentSideConnection;
	sessions: Map<string, SessionState>;
	modelRegistry: ModelRegistry;
}

/**
 * Wire internal subscribers that translate state-change events into the
 * spec-stable ACP `config_option_update` sessionUpdate. Picker state on the
 * client refreshes without polling. Demonstrates the same hook surface
 * extensions consume — the bodhi-pi picker-refresh ships through the same bus.
 */
export function wireInternalEventHandlers(deps: EventWiringDeps): void {
	const { events, conn, sessions, modelRegistry } = deps;
	const emitUpdate = async (sessionId: string) => {
		if (!sessions.has(sessionId)) return;
		const configOptions = await modelRegistry.buildAllConfigOptions(sessionId);
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
}

/** Dotted-key paths whose changes reshape the model picker advertised in `configOptions`. */
function affectsPickerKey(key: string): boolean {
	return (
		key === "defaultModel" ||
		key.startsWith("defaultModel.") ||
		key === "defaultThinkingLevel" ||
		key.startsWith("defaultThinkingLevel.")
	);
}
