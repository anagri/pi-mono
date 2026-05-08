import { randomUUID } from "node:crypto";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model, TextContent } from "@mariozechner/pi-ai";
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
 * Aggregates extension contributions across factories: tools, commands, providers,
 * lifecycle event handlers, and inter-extension pub/sub bus.
 *
 * Builtin tools always win on name collision (see {@link mergeTools}).
 * Builtin slash-command/skill names always win in the same way.
 */
export class ExtensionRunner {
	private readonly tools: AgentTool[] = [];
	private readonly commands: PromptTemplate[] = [];
	private readonly providers = new Map<string, ProviderConfig>();
	private readonly eventHandlers: BodhiPiEventHandlers = {};
	private readonly bus = createExtensionEventBus();
	private readonly conn: AgentSideConnection;
	private readonly sessionStore: SessionStore;

	private constructor(opts: { conn: AgentSideConnection; sessionStore: SessionStore }) {
		this.conn = opts.conn;
		this.sessionStore = opts.sessionStore;
	}

	static async build(opts: {
		conn: AgentSideConnection;
		sessionStore: SessionStore;
		extensions: RegisteredExtension[];
	}): Promise<ExtensionRunner> {
		const runner = new ExtensionRunner({ conn: opts.conn, sessionStore: opts.sessionStore });
		for (const ext of opts.extensions) {
			const api = runner.buildApiFor(ext.name);
			try {
				await ext.factory(api);
			} catch (err) {
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
				return () => {
					const idx = self.commands.indexOf(tmpl);
					if (idx >= 0) self.commands.splice(idx, 1);
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

	/** Provider-supplied API keys. Returns the first non-undefined match. */
	resolveProviderKey(provider: string): string | undefined | Promise<string | undefined> {
		for (const cfg of this.providers.values()) {
			if (cfg.getApiKey) {
				const key = cfg.getApiKey(provider);
				if (key !== undefined) return key;
			}
		}
		return undefined;
	}
}

/** Merge extension tools into the builtin set. Builtins win on name collision. */
export function mergeTools(builtins: AgentTool[], extensions: AgentTool[]): AgentTool[] {
	const builtinNames = new Set(builtins.map((t) => t.name));
	return [...builtins, ...extensions.filter((t) => !builtinNames.has(t.name))];
}

/** Merge extension commands into the project commands. Project commands win on name collision. */
export function mergeCommands(project: PromptTemplate[], extensions: PromptTemplate[]): PromptTemplate[] {
	const projectNames = new Set(project.map((c) => c.name));
	return [...project, ...extensions.filter((c) => !projectNames.has(c.name))];
}
