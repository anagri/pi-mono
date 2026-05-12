import { randomUUID } from "node:crypto";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { PromptTemplate } from "@/commands/prompt-templates.js";
import type { BodhiPiEventHandlers, BodhiPiEventType } from "@/events/types.js";
import type { SessionStore } from "@/sessions/session-store.js";
import { createExtensionEventBus } from "./events-bus.js";
import { adaptExtensionTool } from "./tool-adapter.js";
import type {
	ExtensionAPI,
	ExtensionCommandDefinition,
	ExtensionEntryPayload,
	ExtensionEventHandler,
	ExtensionToolDefinition,
	ProviderConfig,
	RegisteredExtension,
} from "./types.js";

/**
 * Per-extension factory failure captured during {@link ExtensionRunner.build}.
 * Hosts can read these via {@link ExtensionRunner.getExtensionErrors} to surface
 * the failure to the user — without it, a bad extension is silently lost.
 */
export interface ExtensionFactoryError {
	extensionName: string;
	error: unknown;
}

/**
 * Aggregates extension contributions across factories: tools, commands, providers,
 * lifecycle event handlers, and inter-extension pub/sub bus.
 *
 * Collision semantics differ per surface:
 *   - **Tools**: builtin tools win (see {@link mergeTools}). Extensions cannot
 *     shadow `read`, `write`, etc.
 *   - **Slash commands**: project-defined commands beat extension-registered
 *     commands of the same name (see {@link mergeCommands}). User intent in the
 *     working tree outranks plugin contributions.
 *   - **Providers**: first registered wins (see {@link buildApiFor}).
 */
/**
 * Optional callback the agent supplies so the runner can ask the host to
 * re-emit `available_commands_update` for a session (or all loaded sessions
 * when `sessionId` is omitted) after the slash-command registry mutates. See
 * `BodhiPiAgent.refreshSlashable` for the corresponding implementation.
 */
export type RequestSlashableRefresh = (sessionId?: string) => Promise<void>;

export class ExtensionRunner {
	private readonly tools: AgentTool[] = [];
	private readonly commands: PromptTemplate[] = [];
	private readonly providers = new Map<string, ProviderConfig>();
	private readonly eventHandlers: BodhiPiEventHandlers = {};
	private readonly bus = createExtensionEventBus();
	private readonly conn: AgentSideConnection;
	private readonly sessionStore: SessionStore;
	private readonly errors: ExtensionFactoryError[] = [];
	private readonly requestSlashableRefresh?: RequestSlashableRefresh;

	private constructor(opts: {
		conn: AgentSideConnection;
		sessionStore: SessionStore;
		requestSlashableRefresh?: RequestSlashableRefresh;
	}) {
		this.conn = opts.conn;
		this.sessionStore = opts.sessionStore;
		this.requestSlashableRefresh = opts.requestSlashableRefresh;
	}

	static async build(opts: {
		conn: AgentSideConnection;
		sessionStore: SessionStore;
		extensions: RegisteredExtension[];
		requestSlashableRefresh?: RequestSlashableRefresh;
	}): Promise<ExtensionRunner> {
		const runner = new ExtensionRunner({
			conn: opts.conn,
			sessionStore: opts.sessionStore,
			requestSlashableRefresh: opts.requestSlashableRefresh,
		});
		for (const ext of opts.extensions) {
			const api = runner.buildApiFor(ext.name);
			try {
				await ext.factory(api);
			} catch (err) {
				// Capture for later programmatic inspection by the host. We also log
				// to console so dev-tools / stderr surfaces it without explicit access.
				runner.errors.push({ extensionName: ext.name, error: err });
				console.error(`[bodhi-pi extension:${ext.name}] factory threw`, err);
			}
		}
		return runner;
	}

	private buildApiFor(extensionName: string): ExtensionAPI {
		const self = this;
		return {
			on<T extends BodhiPiEventType>(type: T, handler: ExtensionEventHandler<T>): () => void {
				if (!self.eventHandlers[type]) self.eventHandlers[type] = [];
				const list = self.eventHandlers[type] as Array<ExtensionEventHandler<T>>;
				list.push(handler);
				return () => {
					const idx = list.indexOf(handler);
					if (idx >= 0) list.splice(idx, 1);
				};
			},
			registerTool<P extends TSchema, D = unknown>(def: ExtensionToolDefinition<P, D>): () => void {
				const adapted = adaptExtensionTool(def) as AgentTool;
				self.tools.push(adapted);
				return () => {
					const idx = self.tools.indexOf(adapted);
					if (idx >= 0) self.tools.splice(idx, 1);
				};
			},
			registerCommand(name: string, def: ExtensionCommandDefinition): () => void {
				const tmpl: PromptTemplate = {
					name,
					description: def.description,
					content: def.template,
					filePath: `extension:${extensionName}/${name}`,
					...(def.argumentHint !== undefined ? { argumentHint: def.argumentHint } : {}),
				};
				self.commands.push(tmpl);
				// Fire-and-forget — the refresh fans out to every loaded session.
				// Failures are surfaced via the agent's notification path, not here.
				void self.requestSlashableRefresh?.();
				return () => {
					const idx = self.commands.indexOf(tmpl);
					if (idx >= 0) self.commands.splice(idx, 1);
					void self.requestSlashableRefresh?.();
				};
			},
			registerProvider(name: string, config: ProviderConfig): () => void {
				// First-wins on collision (matches web-acp-agent loader semantics).
				if (!self.providers.has(name)) self.providers.set(name, config);
				return () => self.providers.delete(name);
			},
			events: self.bus,
			async appendEntry(sessionId: string, entry: ExtensionEntryPayload): Promise<void> {
				await self.sessionStore.append(sessionId, {
					type: "extension",
					id: randomUUID(),
					timestamp: Date.now(),
					extensionName,
					customType: entry.customType,
					data: entry.data,
				});
			},
			async sendMessage(sessionId: string, content: TextContent | TextContent[] | string): Promise<void> {
				const text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content.map((c) => c.text).join("")
							: content.text;
				await self.conn.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text },
					},
				});
			},
			async requestSlashableRefresh(sessionId: string): Promise<void> {
				await self.requestSlashableRefresh?.(sessionId);
			},
		};
	}

	/** All event handlers registered by extensions, keyed by event type. */
	getEventHandlers(): BodhiPiEventHandlers {
		return this.eventHandlers;
	}

	/** Tools contributed by extensions. */
	getTools(): AgentTool[] {
		return this.tools;
	}

	/** Commands (prompt templates) contributed by extensions. */
	getCommands(): PromptTemplate[] {
		return this.commands;
	}

	/** Provider models contributed by extensions, in registration order. */
	getProviderModels(): Model<Api>[] {
		return [...this.providers.values()].map((p) => p.model);
	}

	/** Per-extension factory failures captured during {@link build}. */
	getExtensionErrors(): readonly ExtensionFactoryError[] {
		return this.errors;
	}

	/** Provider-supplied API keys. Returns the first non-undefined match. */
	async resolveProviderKey(provider: string): Promise<string | undefined> {
		for (const cfg of this.providers.values()) {
			if (cfg.getApiKey) {
				const resolved = await cfg.getApiKey(provider);
				if (resolved !== undefined) return resolved;
			}
		}
		return undefined;
	}
}
