import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	BodhiPiEvent,
	BodhiPiEventHandlers,
	InputEvent,
	InputEventResult,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "./types.js";

/**
 * Sequential async dispatcher for bodhi-pi lifecycle events.
 *
 * Errors thrown by handlers are caught and logged via `console.error`; peer
 * handlers still run, and event propagation is not blocked. See
 * {@link BodhiPiEventHandlers} for the full per-event contract.
 *
 * Observation-only events (the discriminated members of {@link BodhiPiEvent}
 * other than the five mutation-aware ones) all flow through {@link emit}.
 * The five mutation-aware emitters keep dedicated methods because they merge
 * handler return values into the dispatched payload.
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

	/**
	 * Fire an observation-only event. The handler list is read by the event's
	 * `type` discriminator; the event object is passed unchanged. Return values
	 * from handlers are ignored — use the dedicated mutation emitters
	 * (`emitInput`, `emitBeforeAgentStart`, `emitBeforeProviderRequest`,
	 * `emitToolCall`, `emitToolResult`) when handler output should mutate the
	 * dispatched payload.
	 */
	async emit<E extends BodhiPiEvent>(event: E): Promise<void> {
		const list = this.handlers[event.type as keyof BodhiPiEventHandlers] as
			| ReadonlyArray<(e: E) => unknown>
			| undefined;
		if (!list || list.length === 0) return;
		for (const h of list) await this.safeRun(h, event, event.type);
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
