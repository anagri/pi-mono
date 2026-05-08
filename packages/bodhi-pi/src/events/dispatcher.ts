import type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BodhiPiEventHandlers,
	InputEvent,
	InputEventResult,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	TurnStartEvent,
} from "./types.js";

/**
 * Sequential async dispatcher for bodhi-pi lifecycle events.
 *
 * Errors thrown by handlers are caught and logged; peer handlers still run.
 * Mutation-aware emitters return the merged/mutated payload — callers apply it.
 */
export class EventDispatcher {
	private readonly handlers: BodhiPiEventHandlers;

	constructor(handlers: BodhiPiEventHandlers = {}) {
		this.handlers = { ...handlers };
	}

	/** Append additional handlers for a given event type (used when extensions register late). */
	appendHandlers<T extends keyof BodhiPiEventHandlers>(
		type: T,
		newHandlers: NonNullable<BodhiPiEventHandlers[T]>,
	): void {
		const existing = (this.handlers[type] ?? []) as NonNullable<BodhiPiEventHandlers[T]>;
		this.handlers[type] = [...existing, ...newHandlers] as BodhiPiEventHandlers[T];
	}

	private async safeRun<E>(handler: (event: E) => unknown, event: E, label: string): Promise<unknown> {
		try {
			return await handler(event);
		} catch (err) {
			console.error(`[bodhi-pi event:${label}] handler threw`, err);
			return undefined;
		}
	}

	// === Observation-only emitters ===

	async emitSessionStart(event: SessionStartEvent): Promise<void> {
		for (const h of this.handlers.session_start ?? []) await this.safeRun(h, event, "session_start");
	}

	async emitSessionShutdown(event: SessionShutdownEvent): Promise<void> {
		for (const h of this.handlers.session_shutdown ?? []) await this.safeRun(h, event, "session_shutdown");
	}

	async emitAgentStart(event: AgentStartEvent): Promise<void> {
		for (const h of this.handlers.agent_start ?? []) await this.safeRun(h, event, "agent_start");
	}

	async emitAgentEnd(event: AgentEndEvent): Promise<void> {
		for (const h of this.handlers.agent_end ?? []) await this.safeRun(h, event, "agent_end");
	}

	async emitTurnStart(event: TurnStartEvent): Promise<void> {
		for (const h of this.handlers.turn_start ?? []) await this.safeRun(h, event, "turn_start");
	}

	async emitTurnEnd(event: TurnEndEvent): Promise<void> {
		for (const h of this.handlers.turn_end ?? []) await this.safeRun(h, event, "turn_end");
	}

	async emitMessageStart(event: MessageStartEvent): Promise<void> {
		for (const h of this.handlers.message_start ?? []) await this.safeRun(h, event, "message_start");
	}

	async emitMessageUpdate(event: MessageUpdateEvent): Promise<void> {
		for (const h of this.handlers.message_update ?? []) await this.safeRun(h, event, "message_update");
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<void> {
		for (const h of this.handlers.message_end ?? []) await this.safeRun(h, event, "message_end");
	}

	async emitToolExecutionStart(event: ToolExecutionStartEvent): Promise<void> {
		for (const h of this.handlers.tool_execution_start ?? []) await this.safeRun(h, event, "tool_execution_start");
	}

	async emitToolExecutionUpdate(event: ToolExecutionUpdateEvent): Promise<void> {
		for (const h of this.handlers.tool_execution_update ?? []) await this.safeRun(h, event, "tool_execution_update");
	}

	async emitToolExecutionEnd(event: ToolExecutionEndEvent): Promise<void> {
		for (const h of this.handlers.tool_execution_end ?? []) await this.safeRun(h, event, "tool_execution_end");
	}

	async emitAfterProviderResponse(event: AfterProviderResponseEvent): Promise<void> {
		for (const h of this.handlers.after_provider_response ?? [])
			await this.safeRun(h, event, "after_provider_response");
	}

	async emitModelSelect(event: ModelSelectEvent): Promise<void> {
		for (const h of this.handlers.model_select ?? []) await this.safeRun(h, event, "model_select");
	}

	// === Mutable emitters ===

	async emitInput(event: InputEvent): Promise<{ text: string; handled: boolean }> {
		let text = event.text;
		let handled = false;
		for (const h of this.handlers.input ?? []) {
			const result = (await this.safeRun(h, { ...event, text }, "input")) as InputEventResult | undefined;
			if (result?.text !== undefined) text = result.text;
			if (result?.handled) handled = true;
		}
		return { text, handled };
	}

	async emitBeforeAgentStart(event: BeforeAgentStartEvent): Promise<{ systemPrompt: string; userPrompt: string }> {
		let systemPrompt = event.systemPrompt;
		let userPrompt = event.userPrompt;
		for (const h of this.handlers.before_agent_start ?? []) {
			const result = (await this.safeRun(h, { ...event, systemPrompt, userPrompt }, "before_agent_start")) as
				| BeforeAgentStartEventResult
				| undefined;
			if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
			if (result?.userPrompt !== undefined) userPrompt = result.userPrompt;
		}
		return { systemPrompt, userPrompt };
	}

	async emitBeforeProviderRequest(event: BeforeProviderRequestEvent): Promise<unknown> {
		let payload: unknown = event.payload;
		for (const h of this.handlers.before_provider_request ?? []) {
			const result = await this.safeRun(h, { ...event, payload }, "before_provider_request");
			if (result !== undefined) payload = result;
		}
		return payload;
	}

	async emitToolCall(event: ToolCallEvent): Promise<{ block: boolean; reason?: string }> {
		// Per pi-agent-core semantics: handler mutates `event.input` in place to rewrite args,
		// or returns `{ block: true, reason }` to abort. First-blocking handler wins.
		for (const h of this.handlers.tool_call ?? []) {
			const result = (await this.safeRun(h, event, "tool_call")) as ToolCallEventResult | undefined;
			if (result?.block) return { block: true, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
		}
		return { block: false };
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult> {
		// Handlers may mutate `event.result` in place OR return overrides; we merge field-by-field
		// using pi-agent-core's `AfterToolCallResult` semantics (no deep merge).
		const overrides: ToolResultEventResult = {};
		for (const h of this.handlers.tool_result ?? []) {
			const result = (await this.safeRun(h, event, "tool_result")) as ToolResultEventResult | undefined;
			if (result?.content !== undefined) overrides.content = result.content;
			if (result?.details !== undefined) overrides.details = result.details;
			if (result?.isError !== undefined) overrides.isError = result.isError;
		}
		return overrides;
	}
}
