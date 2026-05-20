import { RequestError, type SessionConfigOption, type SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { randomUUID } from "@/_internal/uuid.js";
import type { BodhiPiLogger } from "@/acp/agent.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import { createEvent } from "@/events/factory.js";
import type { McpToolAnnotations } from "@/mcp/mcp-types.js";
import type { SessionEntry } from "@/sessions/entries.js";
import type { SessionState } from "@/sessions/session-state.js";
import { toolKindFor } from "@/tools/index.js";
import { MODE_CONFIG_ID } from "@/wire/constants.js";
import { MODE_PRESETS } from "./presets.js";
import {
	type AgentMode,
	ALL_AGENT_MODES,
	type ApprovalDecision,
	isAgentMode,
	MODE_DISPLAY,
	type ModeChangeReason,
	type ModeRuntimeCapabilities,
	type ToolCategory,
} from "./types.js";

export type AppendEntry = (sessionId: string, session: SessionState, entry: SessionEntry) => Promise<void>;

export type McpAnnotationLookup = (sessionId: string, fullName: string) => McpToolAnnotations | undefined;

export interface PermissionServiceDeps {
	sessions: Map<string, SessionState>;
	events: EventDispatcher;
	appendEntry: AppendEntry;
	capabilities: ModeRuntimeCapabilities;
	logger: BodhiPiLogger;
	/** Resolve MCP annotations for a `<slug>__<tool>` tool name. Optional; absence = research-permissive default-allow. */
	mcpAnnotationLookup?: McpAnnotationLookup;
}

export interface ToolCallDescriptor {
	id: string;
	name: string;
	arguments: unknown;
}

export class PermissionService {
	private readonly sessions: Map<string, SessionState>;
	private readonly events: EventDispatcher;
	private readonly appendEntry: AppendEntry;
	readonly capabilities: ModeRuntimeCapabilities;
	private readonly logger: BodhiPiLogger;
	private readonly mcpAnnotationLookup: McpAnnotationLookup | undefined;

	constructor(deps: PermissionServiceDeps) {
		this.sessions = deps.sessions;
		this.events = deps.events;
		this.appendEntry = deps.appendEntry;
		this.capabilities = deps.capabilities;
		this.logger = deps.logger;
		this.mcpAnnotationLookup = deps.mcpAnnotationLookup;
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
	 * Policy evaluation. Phase 1 enforces plan mode; ask/edit/allow-all stay inert (allow-all
	 * preset already allows everything; ask/edit policies are empty → fall through to allow).
	 * MCP tools consult annotations via `mcpAnnotationLookup` (research-permissive default: absent
	 * annotations OR no lookup → allow).
	 */
	async evaluateToolCall(sessionId: string, toolCall: ToolCallDescriptor): Promise<ApprovalDecision> {
		const session = this.sessions.get(sessionId);
		if (!session) return { kind: "allow" };
		const mode = session.runtime.mode;
		const preset = MODE_PRESETS[mode];
		const category = toolKindFor(toolCall.name);
		if (category === "mcp") {
			return this.evaluateMcpTool(sessionId, toolCall.name, mode);
		}
		const decision = preset.policy.categories[category];
		if (decision === "deny") {
			return { kind: "deny", reason: buildPlanDenyReason(toolCall.name, category) };
		}
		return { kind: "allow" };
	}

	private evaluateMcpTool(sessionId: string, fullName: string, mode: AgentMode): ApprovalDecision {
		if (mode !== "plan") return { kind: "allow" };
		const annotations = this.mcpAnnotationLookup?.(sessionId, fullName);
		if (!annotations) return { kind: "allow" };
		if (annotations.readOnlyHint === true) return { kind: "allow" };
		if (annotations.destructiveHint === true) {
			return { kind: "deny", reason: buildPlanDenyReason(fullName, "mcp") };
		}
		return { kind: "allow" };
	}
}

function buildPlanDenyReason(toolName: string, category: ToolCategory): string {
	return `plan mode is read-only — \`${toolName}\` blocked (category: ${category}). Use read-only tools or \`/mode edit\` to proceed.`;
}
