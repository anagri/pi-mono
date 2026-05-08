import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Api, Model, TextContent } from "@mariozechner/pi-ai";
import type { Static, TSchema } from "typebox";
import type {
	BeforeAgentStartEventResult,
	BeforeProviderRequestEventResult,
	BodhiPiEvent,
	BodhiPiEventType,
	InputEventResult,
	ToolCallEventResult,
	ToolResultEventResult,
} from "@/events/types.js";

/**
 * A custom LLM-callable tool registered by an extension.
 *
 * Mirrors `AgentTool` from pi-agent-core but exposes a thinner surface:
 * extensions don't need `prepareArguments`, `label`, or `executionMode`.
 */
export interface ExtensionToolDefinition<TParameters extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	description: string;
	parameters: TParameters;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<TDetails>> | AgentToolResult<TDetails>;
}

/** Slash-command definition. The template is expanded via the same engine as project commands. */
export interface ExtensionCommandDefinition {
	description: string;
	argumentHint?: string;
	/** Body of the prompt template; supports `$1`, `$@`, `$ARGUMENTS` placeholders. */
	template: string;
}

/**
 * Custom LLM provider/model registered by an extension. The supplied `model`
 * becomes a valid `setSessionConfigOption` target. Optional `getApiKey` is
 * consulted *after* the host's `getApiKey` for any provider not the host knows.
 */
export interface ProviderConfig {
	model: Model<Api>;
	getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

/** Payload accepted by `pi.appendEntry`. The runner stamps `id`, `timestamp`, `extensionName`. */
export interface ExtensionEntryPayload {
	customType: string;
	data: unknown;
}

type Awaitable<T> = T | Promise<T>;

/** Type-narrowed event handler matching `BodhiPiEventHandlers`. */
export type ExtensionEventHandler<T extends BodhiPiEventType> = (
	event: Extract<BodhiPiEvent, { type: T }>,
) => Awaitable<
	T extends "input"
		? InputEventResult | undefined
		: T extends "before_agent_start"
			? BeforeAgentStartEventResult | undefined
			: T extends "before_provider_request"
				? BeforeProviderRequestEventResult
				: T extends "tool_call"
					? ToolCallEventResult | undefined
					: T extends "tool_result"
						? ToolResultEventResult | undefined
						: void
>;

/**
 * Headless extension API exposed to factories.
 *
 * TUI-only methods from coding-agent (`registerShortcut`, `registerMessageRenderer`,
 * `registerFlag`, `setStatus`, `ctx.ui.*`) are intentionally absent.
 */
export interface ExtensionAPI {
	on<T extends BodhiPiEventType>(type: T, handler: ExtensionEventHandler<T>): () => void;
	registerTool<P extends TSchema, D = unknown>(def: ExtensionToolDefinition<P, D>): () => void;
	registerCommand(name: string, def: ExtensionCommandDefinition): () => void;
	registerProvider(name: string, config: ProviderConfig): () => void;
	events: ExtensionEventBus;
	appendEntry(sessionId: string, entry: ExtensionEntryPayload): Promise<void>;
	sendMessage(sessionId: string, content: TextContent | TextContent[] | string): Promise<void>;
}

/** Inter-extension pub/sub. Channels are arbitrary opaque strings. */
export interface ExtensionEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
}

/** Factory signature for extension authors. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** Runner-input — pairs a factory with its extension name (used for appendEntry tagging). */
export interface RegisteredExtension {
	name: string;
	factory: ExtensionFactory;
}
