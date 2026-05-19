import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentMode, ModeChangeReason, ToolCategory } from "@/permissions/types.js";

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "cancelled" | "refusal";

export interface BodhiPiEventCommon {
	serverTime?: number;
}

// === Session lifecycle ===

export interface SessionStartEvent extends BodhiPiEventCommon {
	type: "session_start";
	sessionId: string;
	cwd: string;
	reason: "new" | "load" | "resume";
}

export interface SessionShutdownEvent extends BodhiPiEventCommon {
	type: "session_shutdown";
	sessionId: string;
}

// === Agent run lifecycle ===

export interface AgentStartEvent extends BodhiPiEventCommon {
	type: "agent_start";
	sessionId: string;
	userPrompt: string;
}

export interface AgentEndEvent extends BodhiPiEventCommon {
	type: "agent_end";
	sessionId: string;
	stopReason?: StopReason;
	messages: AgentMessage[];
	errorMessage?: string;
}

export interface TurnStartEvent extends BodhiPiEventCommon {
	type: "turn_start";
	sessionId: string;
}

export interface TurnEndEvent extends BodhiPiEventCommon {
	type: "turn_end";
	sessionId: string;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

// === Mutable input/system-prompt hooks (fired before piAgent.prompt) ===

export interface InputEvent extends BodhiPiEventCommon {
	type: "input";
	sessionId: string;
	text: string;
	source: "acp";
}
export interface InputEventResult {
	text?: string;
	handled?: boolean;
}

export interface BeforeAgentStartEvent extends BodhiPiEventCommon {
	type: "before_agent_start";
	sessionId: string;
	systemPrompt: string;
	userPrompt: string;
}
export interface BeforeAgentStartEventResult {
	systemPrompt?: string;
	userPrompt?: string;
}

// === Provider request/response (mapped to pi-agent-core's onPayload/onResponse) ===

export interface BeforeProviderRequestEvent extends BodhiPiEventCommon {
	type: "before_provider_request";
	sessionId: string;
	provider: string;
	modelId: string;
	payload: unknown;
}
export type BeforeProviderRequestEventResult = unknown | undefined;

export interface AfterProviderResponseEvent extends BodhiPiEventCommon {
	type: "after_provider_response";
	sessionId: string;
	provider: string;
	modelId: string;
	status: number;
	headers: Record<string, string>;
}

// === Streaming message events (forwarded from pi-agent-core's subscribe) ===

export interface MessageStartEvent extends BodhiPiEventCommon {
	type: "message_start";
	sessionId: string;
	message: AgentMessage;
}

export interface MessageUpdateEvent extends BodhiPiEventCommon {
	type: "message_update";
	sessionId: string;
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent extends BodhiPiEventCommon {
	type: "message_end";
	sessionId: string;
	message: AgentMessage;
}

// === Tool execution observations (forwarded from pi-agent-core's subscribe) ===

export interface ToolExecutionStartEvent extends BodhiPiEventCommon {
	type: "tool_execution_start";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
}

export interface ToolExecutionUpdateEvent extends BodhiPiEventCommon {
	type: "tool_execution_update";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	partialResult: unknown;
}

export interface ToolExecutionEndEvent extends BodhiPiEventCommon {
	type: "tool_execution_end";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

// === Mutable tool_call / tool_result (mapped to pi-agent-core's beforeToolCall / afterToolCall) ===

export interface ToolCallEvent extends BodhiPiEventCommon {
	type: "tool_call";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	/** Mutable in place — handlers may rewrite arguments before tool executes. */
	input: Record<string, unknown>;
}
export interface ToolCallEventResult {
	block?: boolean;
	reason?: string;
}

export interface ToolResultEvent extends BodhiPiEventCommon {
	type: "tool_result";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	/** Mutable in place — handlers may rewrite content/details/isError before persisting. */
	result: AgentToolResult<unknown>;
	isError: boolean;
}
export interface ToolResultEventResult {
	content?: AgentToolResult<unknown>["content"];
	details?: unknown;
	isError?: boolean;
}

// === Model selection ===

export interface ModelSelectEvent extends BodhiPiEventCommon {
	type: "model_select";
	sessionId: string;
	/** `null` on the first model selection in a session that booted without an auth-resolvable model. */
	fromModelId: string | null;
	toModelId: string;
}

// === Auth / KV state changes ===

/**
 * Fired after `_bodhi-pi/kv/set` or `_bodhi-pi/kv/remove` with a key under
 * `auth/<provider>`. `sessionId` is the calling session if the request carried
 * one (typical for /login); off-session writes pass `undefined`.
 */
export interface AuthChangeEvent extends BodhiPiEventCommon {
	type: "auth_change";
	sessionId: string | undefined;
	provider: string;
	action: "login" | "logout";
}

// === Settings state changes ===

/**
 * Fired after a settings write/clear at any scope. `value` is the new value for
 * `set`, `null` for `unset`. The agent's internal subscriber refreshes the
 * picker via `config_option_update` when `key` is `defaultModel` or
 * `defaultThinkingLevel`; extensions may subscribe for any key.
 */
export interface SettingsChangeEvent extends BodhiPiEventCommon {
	type: "settings_change";
	sessionId: string;
	scope: "global" | "project" | "session";
	key: string;
	value: unknown | null;
	reason: "set" | "unset";
}

// === Compaction lifecycle ===

export interface CompactionStartEvent extends BodhiPiEventCommon {
	type: "compaction_start";
	sessionId: string;
	reason: "manual" | "proactive" | "recovery";
}

export interface CompactionEndEvent extends BodhiPiEventCommon {
	type: "compaction_end";
	sessionId: string;
	reason: "manual" | "proactive" | "recovery";
	/** Defined when the compaction succeeded; absent on failure. */
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	/** Defined when the compaction failed (caught error). */
	errorMessage?: string;
}

// === Branch summary ===

export interface BranchSummaryCreatedEvent extends BodhiPiEventCommon {
	type: "branch_summary_created";
	sessionId: string;
	abandonedTailLeafId: string;
	commonAncestorId: string | null;
	summary: string;
}

// === MCP lifecycle ===

export interface McpStatusChangeEvent extends BodhiPiEventCommon {
	type: "mcp_status_change";
	sessionId: string;
	slug: string;
	status: "connected" | "disconnected" | "error";
	errorMessage?: string;
}

export interface McpToolsChangeEvent extends BodhiPiEventCommon {
	type: "mcp_tools_change";
	sessionId: string;
	slug: string;
	toolNames: string[];
}

export interface McpOAuthStatusChangeEvent extends BodhiPiEventCommon {
	type: "mcp_oauth_status_change";
	sessionId: string;
	slug: string;
	status: "started" | "completed" | "failed" | "cancelled";
	errorMessage?: string;
}

// === Session navigate ===

export interface SessionNavigateEvent extends BodhiPiEventCommon {
	type: "session_navigate";
	sessionId: string;
	fromLeafId: string | null;
	toLeafId: string;
	crossedBranches: boolean;
}

// === Session fork / clone ===

export interface SessionForkEvent extends BodhiPiEventCommon {
	type: "session_fork";
	/** The source session that was forked from. */
	sessionId: string;
	newSessionId: string;
	fromEntryId: string;
	position: "before" | "at";
}

export interface SessionCloneEvent extends BodhiPiEventCommon {
	type: "session_clone";
	/** The source session that was cloned from. */
	sessionId: string;
	newSessionId: string;
	fromLeafId: string;
}

// === Mode / permission lifecycle ===

export interface ModeChangeEvent extends BodhiPiEventCommon {
	type: "mode_change";
	sessionId: string;
	fromMode: AgentMode | null;
	toMode: AgentMode;
	reason: ModeChangeReason;
}

export interface ToolApprovalRequestEvent extends BodhiPiEventCommon {
	type: "tool_approval_request";
	sessionId: string;
	correlationId: string;
	toolCallId: string;
	toolName: string;
	category: ToolCategory;
	pattern: string;
	timeoutMs: number;
}

export type ToolApprovalKind =
	| "allow_once"
	| "allow_always"
	| "reject_once"
	| "reject_always"
	| "cancelled"
	| "timeout";

export interface ToolApprovalResponseEvent extends BodhiPiEventCommon {
	type: "tool_approval_response";
	sessionId: string;
	correlationId: string;
	toolCallId: string;
	toolName: string;
	kind: ToolApprovalKind;
}

/**
 * Fired when `PermissionService.evaluateToolCall` returns `{ kind: "deny" }` and the
 * gate in `createPiAgent.beforeToolCall` rejects the call. One-shot lifecycle event
 * (no wire round-trip); Hosts subscribe via the lifecycle channel for live UI updates.
 */
export interface ToolBlockedEvent extends BodhiPiEventCommon {
	type: "tool_blocked";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	category: ToolCategory;
	mode: AgentMode;
	reason: string;
}

// === Sub-agent lifecycle ===

export interface SubagentStartEvent extends BodhiPiEventCommon {
	type: "subagent_start";
	parentSessionId: string;
	childSessionId: string;
	profileName: string;
	task: string;
	toolCallId: string;
	depth: number;
	contextMode: "fresh" | "fork";
}

export interface SubagentEndEvent extends BodhiPiEventCommon {
	type: "subagent_end";
	parentSessionId: string;
	childSessionId: string;
	profileName: string;
	status: "completed" | "cancelled" | "failed";
	durationMs: number;
	toolCount: number;
	contextMode: "fresh" | "fork";
	summary?: string;
	error?: string;
}

// === Discriminated union ===

export type BodhiPiEvent =
	| SessionStartEvent
	| SessionShutdownEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| InputEvent
	| BeforeAgentStartEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ToolCallEvent
	| ToolResultEvent
	| ModelSelectEvent
	| AuthChangeEvent
	| SettingsChangeEvent
	| CompactionStartEvent
	| CompactionEndEvent
	| BranchSummaryCreatedEvent
	| SessionNavigateEvent
	| SessionForkEvent
	| SessionCloneEvent
	| McpStatusChangeEvent
	| McpToolsChangeEvent
	| McpOAuthStatusChangeEvent
	| ModeChangeEvent
	| ToolApprovalRequestEvent
	| ToolApprovalResponseEvent
	| ToolBlockedEvent
	| SubagentStartEvent
	| SubagentEndEvent;

export type BodhiPiEventType = BodhiPiEvent["type"];

// === Handler shapes ===

type Awaitable<T> = T | Promise<T>;

/**
 * Per-event handler arrays. Handlers run sequentially in registration order.
 *
 * Errors thrown by a handler are caught by `EventDispatcher` and logged via
 * `console.error`; peer handlers continue to run, and event propagation is
 * not interrupted. Handlers MUST NOT rely on synchronous propagation of
 * exceptions — use the dispatched payload's mutation channels (the result
 * shapes for the five mutable events) when intentional cross-handler signals
 * are required.
 */
export interface BodhiPiEventHandlers {
	session_start?: ((event: SessionStartEvent) => Awaitable<void>)[];
	session_shutdown?: ((event: SessionShutdownEvent) => Awaitable<void>)[];
	agent_start?: ((event: AgentStartEvent) => Awaitable<void>)[];
	agent_end?: ((event: AgentEndEvent) => Awaitable<void>)[];
	turn_start?: ((event: TurnStartEvent) => Awaitable<void>)[];
	turn_end?: ((event: TurnEndEvent) => Awaitable<void>)[];
	input?: ((event: InputEvent) => Awaitable<InputEventResult | undefined>)[];
	before_agent_start?: ((event: BeforeAgentStartEvent) => Awaitable<BeforeAgentStartEventResult | undefined>)[];
	before_provider_request?: ((event: BeforeProviderRequestEvent) => Awaitable<BeforeProviderRequestEventResult>)[];
	after_provider_response?: ((event: AfterProviderResponseEvent) => Awaitable<void>)[];
	message_start?: ((event: MessageStartEvent) => Awaitable<void>)[];
	message_update?: ((event: MessageUpdateEvent) => Awaitable<void>)[];
	message_end?: ((event: MessageEndEvent) => Awaitable<void>)[];
	tool_execution_start?: ((event: ToolExecutionStartEvent) => Awaitable<void>)[];
	tool_execution_update?: ((event: ToolExecutionUpdateEvent) => Awaitable<void>)[];
	tool_execution_end?: ((event: ToolExecutionEndEvent) => Awaitable<void>)[];
	tool_call?: ((event: ToolCallEvent) => Awaitable<ToolCallEventResult | undefined>)[];
	tool_result?: ((event: ToolResultEvent) => Awaitable<ToolResultEventResult | undefined>)[];
	model_select?: ((event: ModelSelectEvent) => Awaitable<void>)[];
	auth_change?: ((event: AuthChangeEvent) => Awaitable<void>)[];
	settings_change?: ((event: SettingsChangeEvent) => Awaitable<void>)[];
	compaction_start?: ((event: CompactionStartEvent) => Awaitable<void>)[];
	compaction_end?: ((event: CompactionEndEvent) => Awaitable<void>)[];
	branch_summary_created?: ((event: BranchSummaryCreatedEvent) => Awaitable<void>)[];
	session_navigate?: ((event: SessionNavigateEvent) => Awaitable<void>)[];
	session_fork?: ((event: SessionForkEvent) => Awaitable<void>)[];
	session_clone?: ((event: SessionCloneEvent) => Awaitable<void>)[];
	mcp_status_change?: ((event: McpStatusChangeEvent) => Awaitable<void>)[];
	mcp_tools_change?: ((event: McpToolsChangeEvent) => Awaitable<void>)[];
	mcp_oauth_status_change?: ((event: McpOAuthStatusChangeEvent) => Awaitable<void>)[];
	mode_change?: ((event: ModeChangeEvent) => Awaitable<void>)[];
	tool_approval_request?: ((event: ToolApprovalRequestEvent) => Awaitable<void>)[];
	tool_approval_response?: ((event: ToolApprovalResponseEvent) => Awaitable<void>)[];
	tool_blocked?: ((event: ToolBlockedEvent) => Awaitable<void>)[];
	subagent_start?: ((event: SubagentStartEvent) => Awaitable<void>)[];
	subagent_end?: ((event: SubagentEndEvent) => Awaitable<void>)[];
}
