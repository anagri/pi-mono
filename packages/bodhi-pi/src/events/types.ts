import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEvent, ToolResultMessage } from "@mariozechner/pi-ai";

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "cancelled" | "refusal";

// === Session lifecycle ===

export interface SessionStartEvent {
	type: "session_start";
	sessionId: string;
	cwd: string;
	reason: "new" | "load" | "resume";
}

export interface SessionShutdownEvent {
	type: "session_shutdown";
	sessionId: string;
}

// === Agent run lifecycle ===

export interface AgentStartEvent {
	type: "agent_start";
	sessionId: string;
	userPrompt: string;
}

export interface AgentEndEvent {
	type: "agent_end";
	sessionId: string;
	stopReason?: StopReason;
	messages: AgentMessage[];
	errorMessage?: string;
}

export interface TurnStartEvent {
	type: "turn_start";
	sessionId: string;
}

export interface TurnEndEvent {
	type: "turn_end";
	sessionId: string;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

// === Mutable input/system-prompt hooks (fired before piAgent.prompt) ===

export interface InputEvent {
	type: "input";
	sessionId: string;
	text: string;
	source: "acp";
}
export interface InputEventResult {
	text?: string;
	handled?: boolean;
}

export interface BeforeAgentStartEvent {
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

export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	sessionId: string;
	provider: string;
	modelId: string;
	payload: unknown;
}
export type BeforeProviderRequestEventResult = unknown | undefined;

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	sessionId: string;
	provider: string;
	modelId: string;
	status: number;
	headers: Record<string, string>;
}

// === Streaming message events (forwarded from pi-agent-core's subscribe) ===

export interface MessageStartEvent {
	type: "message_start";
	sessionId: string;
	message: AgentMessage;
}

export interface MessageUpdateEvent {
	type: "message_update";
	sessionId: string;
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

export interface MessageEndEvent {
	type: "message_end";
	sessionId: string;
	message: AgentMessage;
}

// === Tool execution observations (forwarded from pi-agent-core's subscribe) ===

export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
}

export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	partialResult: unknown;
}

export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	sessionId: string;
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

// === Mutable tool_call / tool_result (mapped to pi-agent-core's beforeToolCall / afterToolCall) ===

export interface ToolCallEvent {
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

export interface ToolResultEvent {
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

export interface ModelSelectEvent {
	type: "model_select";
	sessionId: string;
	fromModelId: string;
	toModelId: string;
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
	| ModelSelectEvent;

export type BodhiPiEventType = BodhiPiEvent["type"];

// === Handler shapes ===

type Awaitable<T> = T | Promise<T>;

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
}
