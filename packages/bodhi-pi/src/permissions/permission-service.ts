import {
	type AgentSideConnection,
	type PermissionOption,
	RequestError,
	type RequestPermissionResponse,
	type SessionConfigOption,
	type SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "@/_internal/uuid.js";
import type { BodhiPiLogger } from "@/acp/agent.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import { createEvent } from "@/events/factory.js";
import type { ToolApprovalKind } from "@/events/types.js";
import type { McpToolAnnotations } from "@/mcp/mcp-types.js";
import type { SessionEntry } from "@/sessions/entries.js";
import type { SessionState } from "@/sessions/session-state.js";
import { toolKindFor, toolKindForAcp } from "@/tools/index.js";
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
	conn: AgentSideConnection;
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
	private readonly conn: AgentSideConnection;
	private readonly appendEntry: AppendEntry;
	readonly capabilities: ModeRuntimeCapabilities;
	private readonly logger: BodhiPiLogger;
	private readonly mcpAnnotationLookup: McpAnnotationLookup | undefined;

	constructor(deps: PermissionServiceDeps) {
		this.sessions = deps.sessions;
		this.events = deps.events;
		this.conn = deps.conn;
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
		// A mode switch must not leak `*_always` grants across modes (an ask-mode allow_always
		// should not silently auto-allow in edit mode). Persistent rules land in milestone 100.
		session.runtime.permissionGrants.clear();
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
	 * Policy evaluation. Plan mode denies mutating categories; ask mode resolves the `ask`
	 * categories (edit/execute/mcp/other) via a native `conn.requestPermission` round-trip; edit
	 * stays inert until milestone 050; allow-all allows everything. MCP tools additionally consult
	 * annotations via `mcpAnnotationLookup` (research-permissive default: absent annotations OR no
	 * lookup → allow).
	 */
	async evaluateToolCall(sessionId: string, toolCall: ToolCallDescriptor): Promise<ApprovalDecision> {
		const session = this.sessions.get(sessionId);
		if (!session) return { kind: "allow" };
		const mode = session.runtime.mode;
		const preset = MODE_PRESETS[mode];
		const category = toolKindFor(toolCall.name);
		if (category === "mcp") {
			return this.evaluateMcpTool(sessionId, session, toolCall, mode);
		}
		const decision = preset.policy.categories[category];
		if (decision === "deny") {
			return { kind: "deny", reason: buildPlanDenyReason(toolCall.name, category) };
		}
		if (decision === "ask") {
			return this.resolveAsk(sessionId, session, toolCall, category);
		}
		return { kind: "allow" };
	}

	private async evaluateMcpTool(
		sessionId: string,
		session: SessionState,
		toolCall: ToolCallDescriptor,
		mode: AgentMode,
	): Promise<ApprovalDecision> {
		const annotations = this.mcpAnnotationLookup?.(sessionId, toolCall.name);
		if (mode === "plan") {
			if (annotations?.readOnlyHint === true) return { kind: "allow" };
			if (annotations?.destructiveHint === true) {
				return { kind: "deny", reason: buildPlanDenyReason(toolCall.name, "mcp") };
			}
			return { kind: "allow" };
		}
		if (MODE_PRESETS[mode].policy.categories.mcp === "ask") {
			if (annotations?.readOnlyHint === true) return { kind: "allow" };
			return this.resolveAsk(sessionId, session, toolCall, "mcp");
		}
		return { kind: "allow" };
	}

	/**
	 * Suspend on an `ask`-category tool: short-circuit on a remembered grant, else emit a pending
	 * tool_call card + `tool_approval_request`, await `conn.requestPermission` raced against the
	 * configured timeout and `session/cancel`, then decode the verdict, record `*_always` grants,
	 * and (on a non-allow verdict) flip the card to `failed`. The gate's existing deny path emits
	 * `tool_blocked` + the `custom_message` entry on the returned `deny`.
	 */
	private async resolveAsk(
		sessionId: string,
		session: SessionState,
		toolCall: ToolCallDescriptor,
		category: ToolCategory,
	): Promise<ApprovalDecision> {
		const grant = session.runtime.permissionGrants.get(toolCall.name);
		if (grant === "allow") return { kind: "allow" };
		if (grant === "deny") return { kind: "deny", reason: buildAskDenyReason(toolCall.name, "reject_always") };

		const correlationId = randomUUID();
		const timeoutMs = session.runtime.approvalTimeoutMs;
		const acpKind = toolKindForAcp(toolCall.name);

		await this.conn.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: toolCall.id,
				title: toolCall.name,
				kind: acpKind,
				status: "pending",
				rawInput: (toolCall.arguments ?? {}) as Record<string, unknown>,
			},
		});
		await this.events.emit(
			createEvent("tool_approval_request", {
				sessionId,
				correlationId,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				category,
				pattern: toolCall.name,
				timeoutMs,
			}),
		);

		let timer: ReturnType<typeof setTimeout> | undefined;
		const kind = await new Promise<ToolApprovalKind>((resolve) => {
			session.runtime.pendingApprovals.set(correlationId, {
				resolve: (response) => resolve(decodeApprovalOutcome(response)),
				toolCallId: toolCall.id,
			});
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
			this.conn
				.requestPermission({
					sessionId,
					toolCall: { toolCallId: toolCall.id, title: toolCall.name, kind: acpKind, status: "pending" },
					options: buildApprovalOptions(),
				})
				.then((response) => resolve(decodeApprovalOutcome(response)))
				.catch((err) => {
					this.logger.error("[bodhi-pi] requestPermission failed:", err);
					resolve("cancelled");
				});
		});
		if (timer) clearTimeout(timer);
		session.runtime.pendingApprovals.delete(correlationId);

		if (kind === "allow_always") session.runtime.permissionGrants.set(toolCall.name, "allow");
		if (kind === "reject_always") session.runtime.permissionGrants.set(toolCall.name, "deny");

		await this.events.emit(
			createEvent("tool_approval_response", {
				sessionId,
				correlationId,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				kind,
			}),
		);

		if (kind === "allow_once" || kind === "allow_always") return { kind: "allow" };
		// The gate's existing deny path turns this into a `failed` tool_call_update (carrying the
		// reason) + `tool_blocked` + custom_message, flipping the pending card — same as plan mode.
		return { kind: "deny", reason: buildAskDenyReason(toolCall.name, kind) };
	}
}

function buildApprovalOptions(): PermissionOption[] {
	return [
		{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
		{ optionId: "allow_always", name: "Allow always (this session)", kind: "allow_always" },
		{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
		{ optionId: "reject_always", name: "Reject always (this session)", kind: "reject_always" },
	];
}

const APPROVAL_OPTION_IDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

function decodeApprovalOutcome(response: RequestPermissionResponse): ToolApprovalKind {
	if (response.outcome.outcome === "cancelled") return "cancelled";
	const optionId = response.outcome.optionId;
	return APPROVAL_OPTION_IDS.has(optionId) ? (optionId as ToolApprovalKind) : "cancelled";
}

function buildPlanDenyReason(toolName: string, category: ToolCategory): string {
	return `plan mode is read-only — \`${toolName}\` blocked (category: ${category}). Use read-only tools or \`/mode edit\` to proceed.`;
}

function buildAskDenyReason(toolName: string, kind: ToolApprovalKind): string {
	if (kind === "timeout") return `\`${toolName}\` approval timed out — tool blocked.`;
	if (kind === "cancelled") return `\`${toolName}\` approval cancelled — tool blocked.`;
	return `\`${toolName}\` rejected by user — tool blocked.`;
}
