import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
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
		onUpdate?: AgentToolUpdateCallback<TDetails>,
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

/**
 * Sub-agent profile contributed by an extension. Mirrors the markdown
 * frontmatter shape so the same validation pipeline (name regex, body
 * trim, maxTurns default) is applied across all contribution sources.
 */
export interface ExtensionSubagentProfileDef {
	name: string;
	description: string;
	body: string;
	model?: string;
	context?: "fresh";
	tools?: string[];
	maxTurns?: number;
	disabled?: boolean;
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
	registerSubagentProfile(def: ExtensionSubagentProfileDef): () => void;
	events: ExtensionEventBus;
	appendEntry(sessionId: string, entry: ExtensionEntryPayload): Promise<void>;
	sendMessage(sessionId: string, content: TextContent | TextContent[] | string): Promise<void>;
	/**
	 * Re-emit the slash-command advertisement (`available_commands_update`) for
	 * the given session. `registerCommand` already triggers this implicitly for
	 * every loaded session — use this method only when you've mutated the command
	 * registry through a path that doesn't go through `registerCommand` directly
	 * (rare; mostly templating-driven extensions).
	 */
	requestSlashableRefresh(sessionId: string): Promise<void>;
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
	/**
	 * When `true`, a factory-throw aborts `ExtensionRunner.build()` (and therefore aborts the
	 * agent's first session-bootstrap call). When `false`/omitted, factory failures are logged
	 * and the runner proceeds without this extension's contributions. Hosts mark extensions
	 * `required: true` when their tools/commands/providers are load-bearing (e.g. the only
	 * provider, or a security-gating extension). Failed extension names are always surfaced
	 * via `initialize` `_meta["bodhi-pi"].extensions.failed[]` regardless of `required`.
	 */
	required?: boolean;
}
