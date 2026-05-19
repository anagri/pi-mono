import { RequestError, type SessionConfigOption, type SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { randomUUID } from "@/_internal/uuid.js";
import type { BodhiPiLogger } from "@/acp/agent.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import { createEvent } from "@/events/factory.js";
import type { SessionEntry } from "@/sessions/entries.js";
import type { SessionState } from "@/sessions/session-state.js";
import { MODE_CONFIG_ID } from "@/wire/constants.js";
import {
	type AgentMode,
	ALL_AGENT_MODES,
	type ApprovalDecision,
	isAgentMode,
	MODE_DISPLAY,
	type ModeChangeReason,
	type ModeRuntimeCapabilities,
} from "./types.js";

export type AppendEntry = (sessionId: string, session: SessionState, entry: SessionEntry) => Promise<void>;

export interface PermissionServiceDeps {
	sessions: Map<string, SessionState>;
	events: EventDispatcher;
	appendEntry: AppendEntry;
	capabilities: ModeRuntimeCapabilities;
	logger: BodhiPiLogger;
}

export class PermissionService {
	private readonly sessions: Map<string, SessionState>;
	private readonly events: EventDispatcher;
	private readonly appendEntry: AppendEntry;
	readonly capabilities: ModeRuntimeCapabilities;
	private readonly logger: BodhiPiLogger;

	constructor(deps: PermissionServiceDeps) {
		this.sessions = deps.sessions;
		this.events = deps.events;
		this.appendEntry = deps.appendEntry;
		this.capabilities = deps.capabilities;
		this.logger = deps.logger;
	}

	getCurrentMode(sessionId: string): AgentMode {
		const session = this.sessions.get(sessionId);
		if (!session) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		return session.runtime.mode;
	}

	buildModeConfigOption(session: SessionState): SessionConfigOption {
		const visibleModes = ALL_AGENT_MODES.filter((m) => m !== "allow-all" || this.capabilities.allowsAllowAllMode);
		const options: SessionConfigSelectOption[] = visibleModes.map((m) => ({
			value: m,
			name: MODE_DISPLAY[m].name,
			description: MODE_DISPLAY[m].description,
		}));
		return {
			id: MODE_CONFIG_ID,
			name: "Session Mode",
			description: "Controls how the agent requests permission",
			category: "mode",
			type: "select",
			currentValue: session.runtime.mode,
			options,
		};
	}

	async setMode(sessionId: string, value: unknown, reason: ModeChangeReason): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		if (!isAgentMode(value)) {
			throw new RequestError(
				-32602,
				`mode config requires one of ${ALL_AGENT_MODES.join(", ")}; got ${String(value)}`,
			);
		}
		if (value === "allow-all" && !this.capabilities.allowsAllowAllMode) {
			throw new RequestError(-32603, "mode 'allow-all' is not enabled on this host");
		}
		const previousMode = session.runtime.mode;
		session.runtime.mode = value;
		await this.appendEntry(sessionId, session, {
			type: "mode_change",
			id: randomUUID(),
			parentId: session.runtime.leafId,
			timestamp: Date.now(),
			mode: value,
			reason,
		});
		await this.events.emit(
			createEvent("mode_change", {
				sessionId,
				fromMode: previousMode,
				toMode: value,
				reason,
			}),
		);
	}

	/**
	 * Policy evaluation stub. Phase 0 ships no enforcement — every call returns `allow`.
	 * Milestone 030 fills in mode-driven category rules + ask flow.
	 */
	async evaluateToolCall(_sessionId: string, _toolName: string): Promise<ApprovalDecision> {
		return { kind: "allow" };
	}
}
