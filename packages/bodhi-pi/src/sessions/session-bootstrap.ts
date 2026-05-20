import { type AgentSideConnection, RequestError } from "@agentclientprotocol/sdk";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core/dist/agent.js";
import {
	type Api,
	clampThinkingLevel,
	type Model,
	type ModelThinkingLevel,
	type ProviderResponse,
} from "@earendil-works/pi-ai";
import { randomUUID } from "@/_internal/uuid.js";
import type { BodhiPiConfig } from "@/acp/agent.js";
import { buildSystemPrompt } from "@/acp/system-prompt.js";
import { loadProjectCommands } from "@/commands/discovery.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import { createEvent } from "@/events/factory.js";
import { mergeCommands, mergeSubagentProfiles, mergeTools } from "@/extensions/merge.js";
import type { ExtensionRunner } from "@/extensions/runner.js";
import { type ModelRegistry, resolveProviderStreamOptions } from "@/models/registry.js";
import type { AppendEntry, PermissionService } from "@/permissions/permission-service.js";
import { MODE_PRESETS } from "@/permissions/presets.js";
import { type AgentMode, DEFAULT_AGENT_MODE, isAgentMode } from "@/permissions/types.js";
import { buildSessionContext } from "@/sessions/build-context.js";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "@/sessions/compaction.js";
import type { CompactionOrchestrator } from "@/sessions/compaction-orchestrator.js";
import type { ResolvedRetryOptions, SessionState } from "@/sessions/session-state.js";
import type { SessionStore } from "@/sessions/session-store.js";
import { type BodhiPiProjectSettings, loadProjectSettings } from "@/settings/settings.js";
import { loadGlobalSettings } from "@/settings/settings-global.js";
import { mergeSettings } from "@/settings/settings-merge.js";
import { loadProjectSkills } from "@/skills/discovery.js";
import type { Skill } from "@/skills/skill.js";
import { loadProjectSubagents } from "@/subagents/discovery.js";
import { getBuiltinSubagentProfiles } from "@/subagents/profiles/index.js";
import type { SubagentService } from "@/subagents/subagent-service.js";
import type { SubagentProfile } from "@/subagents/types.js";
import { BUILTIN_TOOL_SNIPPETS, createBuiltinTools, toolKindFor } from "@/tools/index.js";
import { type ContextFile, loadProjectContextFiles } from "./resource-loader.js";

export interface BootstrapDeps {
	config: BodhiPiConfig;
	events: EventDispatcher;
	conn: AgentSideConnection;
	sessions: Map<string, SessionState>;
	modelRegistry: ModelRegistry;
	compactionOrchestrator: CompactionOrchestrator;
	extensionRunner: () => ExtensionRunner | undefined;
	subagentService: SubagentService;
	permissionService: PermissionService;
	appendEntry: AppendEntry;
}

/**
 * Read all per-cwd bootstrap inputs in parallel: discovered tools, project + global settings,
 * and the merged file-settings view. Pure I/O — no Agent construction yet.
 */
export async function loadProjectArtifacts(
	config: BodhiPiConfig,
	cwd: string,
	sessionId: string,
	subagentService: SubagentService,
	extensionProfiles: SubagentProfile[] = [],
): Promise<{
	builtinTools: ReturnType<typeof createBuiltinTools>;
	projectCommands: Awaited<ReturnType<typeof loadProjectCommands>>;
	skills: Skill[];
	subagentProfiles: SubagentProfile[];
	contextFiles: ContextFile[];
	projectSettingsResult: Awaited<ReturnType<typeof loadProjectSettings>>;
	globalSettingsResult: Awaited<ReturnType<typeof loadGlobalSettings>> | undefined;
	mergedFileSettings: BodhiPiProjectSettings;
}> {
	const loaderOptions = config.logger ? { logger: config.logger } : {};
	const [projectCommands, skills, projectSubagents, contextFiles, projectSettingsResult, globalSettingsResult] =
		await Promise.all([
			loadProjectCommands(config.filesystem, cwd, loaderOptions),
			loadProjectSkills(config.filesystem, cwd, loaderOptions),
			loadProjectSubagents(config.filesystem, cwd, loaderOptions),
			loadProjectContextFiles(config.filesystem, cwd),
			loadProjectSettings(config.filesystem, cwd),
			config.homeDir
				? loadGlobalSettings(config.globalFilesystem ?? config.filesystem, config.homeDir)
				: Promise.resolve(undefined),
		]);
	const subagentProfiles = mergeSubagentProfiles(projectSubagents, extensionProfiles, getBuiltinSubagentProfiles());
	const builtinTools = createBuiltinTools({
		filesystem: config.filesystem,
		cwd,
		...(config.scriptExecutor ? { scriptExecutor: config.scriptExecutor } : {}),
		...(config.terminal ? { terminal: config.terminal } : {}),
		...(subagentProfiles.length > 0
			? { subagent: { sessionId, profiles: subagentProfiles, service: subagentService } }
			: {}),
	});
	const mergedFileSettings = mergeSettings(globalSettingsResult?.settings ?? {}, projectSettingsResult.settings);
	return {
		builtinTools,
		projectCommands,
		skills,
		subagentProfiles,
		contextFiles,
		projectSettingsResult,
		globalSettingsResult,
		mergedFileSettings,
	};
}

/**
 * Build the composed system prompt: optional host-supplied base + builtin tool list + skills section
 * + cwd context-files. `appendSystemPrompt` precedence: host-explicit > `mergedFileSettings.appendSystemPrompt`.
 * `mode` controls which `MODE_PRESETS[mode].systemPromptSuffix` is appended after the standard prompt.
 */
export function composeSystemPrompt(
	config: BodhiPiConfig,
	args: {
		tools: AgentTool[];
		mergedFileSettings: BodhiPiProjectSettings;
		contextFiles: ContextFile[];
		skills: Skill[];
		cwd: string;
		mode: AgentMode;
	},
): { prompt: string; resolvedAppend: string | undefined } {
	const resolvedAppend = config.appendSystemPrompt ?? args.mergedFileSettings.appendSystemPrompt ?? undefined;
	const basePrompt = buildSystemPrompt({
		...(config.systemPrompt !== undefined ? { customPrompt: config.systemPrompt } : {}),
		selectedTools: args.tools.map((t) => t.name),
		toolSnippets: BUILTIN_TOOL_SNIPPETS,
		...(resolvedAppend !== undefined ? { appendSystemPrompt: resolvedAppend } : {}),
		cwd: args.cwd,
		contextFiles: args.contextFiles,
		skills: args.skills,
	});
	const modeSuffix = MODE_PRESETS[args.mode].systemPromptSuffix;
	const prompt = modeSuffix ? `${basePrompt}\n\n${modeSuffix}` : basePrompt;
	return { prompt, resolvedAppend };
}

/**
 * Construct the `pi-agent-core` Agent + wire every event hook onto the dispatcher.
 * `model === null` is legal (no auth-resolvable models); pi-agent-core uses its placeholder model.
 */
export function createPiAgent(
	deps: {
		events: EventDispatcher;
		sessions: Map<string, SessionState>;
		modelRegistry: ModelRegistry;
		compactionOrchestrator: CompactionOrchestrator;
		permissionService: PermissionService;
		appendEntry: AppendEntry;
	},
	args: {
		sessionId: string;
		model: Model<Api> | null;
		messages: AgentMessage[];
		tools: AgentTool[];
		systemPrompt: string | undefined;
		thinkingLevel: ModelThinkingLevel;
		retryOptions: ResolvedRetryOptions;
	},
): Agent {
	const { events, sessions, modelRegistry, compactionOrchestrator, permissionService, appendEntry } = deps;
	const resolveApiKey = (provider: string) => modelRegistry.resolveProviderApiKey(provider);
	return new Agent({
		...args.retryOptions,
		initialState: {
			...(args.model ? { model: args.model } : {}),
			...(args.messages.length > 0 ? { messages: args.messages } : {}),
			tools: args.tools,
			...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
			thinkingLevel: args.thinkingLevel as never, // pi-agent-core types this as `never`; widening up the stack is in this file's section below.
		},
		getApiKey: resolveApiKey,
		beforeToolCall: async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
			const result = await events.emitToolCall(
				createEvent("tool_call", {
					sessionId: args.sessionId,
					toolCallId: ctx.toolCall.id,
					toolName: ctx.toolCall.name,
					input: ctx.args as Record<string, unknown>,
				}),
			);
			if (result.block) {
				return { block: true, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
			}
			const decision = await permissionService.evaluateToolCall(args.sessionId, {
				id: ctx.toolCall.id,
				name: ctx.toolCall.name,
				arguments: ctx.args,
			});
			if (decision.kind === "deny") {
				const session = sessions.get(args.sessionId);
				if (session) {
					const category = toolKindFor(ctx.toolCall.name);
					await events.emit(
						createEvent("tool_blocked", {
							sessionId: args.sessionId,
							toolCallId: ctx.toolCall.id,
							toolName: ctx.toolCall.name,
							category,
							mode: session.runtime.mode,
							reason: decision.reason,
						}),
					);
					await appendEntry(args.sessionId, session, {
						type: "custom_message",
						id: randomUUID(),
						parentId: session.runtime.leafId,
						timestamp: Date.now(),
						extensionName: "modes",
						customType: "tool_blocked",
						content: decision.reason,
						display: true,
					});
				}
				return { block: true, reason: decision.reason };
			}
			return undefined;
		},
		afterToolCall: async (ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
			const overrides = await events.emitToolResult(
				createEvent("tool_result", {
					sessionId: args.sessionId,
					toolCallId: ctx.toolCall.id,
					toolName: ctx.toolCall.name,
					result: ctx.result,
					isError: ctx.isError,
				}),
			);
			return Object.keys(overrides).length === 0 ? undefined : overrides;
		},
		onPayload: async (payload, m) => {
			return await events.emitBeforeProviderRequest(
				createEvent("before_provider_request", {
					sessionId: args.sessionId,
					provider: m.provider,
					modelId: m.id,
					payload,
				}),
			);
		},
		onResponse: async (response: ProviderResponse, m) => {
			await events.emit(
				createEvent("after_provider_response", {
					sessionId: args.sessionId,
					provider: m.provider,
					modelId: m.id,
					status: response.status,
					headers: response.headers,
				}),
			);
		},
		prepareNextTurn: async (): Promise<AgentLoopTurnUpdate | undefined> => {
			const compactUpdate = await compactionOrchestrator.maybeProactiveCompact(args.sessionId);
			const state = sessions.get(args.sessionId);
			if (!state?.runtime.pendingThinkingLevelChange) return compactUpdate;
			state.runtime.pendingThinkingLevelChange = false;
			// pi-agent-core types AgentLoopTurnUpdate.thinkingLevel as `never`; cast is centralised at top of model-registry.ts.
			return { ...(compactUpdate ?? {}), thinkingLevel: state.runtime.thinkingLevel as never };
		},
	});
}

/**
 * Compose a fresh {@link SessionState} from disk artifacts + a (possibly null) model. Skills must
 * load before Agent construction so the system prompt's `<available_skills>` block is in the
 * initial state. Mutates `deps.sessions` by setting the new session entry.
 */
export async function buildSessionState(
	deps: BootstrapDeps,
	args: {
		sessionId: string;
		model: Model<Api> | null;
		cwd: string;
		messages?: AgentMessage[];
		leafId?: string | null;
		initialThinkingLevel?: ModelThinkingLevel | null;
		initialMode?: AgentMode | null;
	},
): Promise<void> {
	const { config, sessions, modelRegistry, compactionOrchestrator, events, extensionRunner } = deps;
	const { sessionId, cwd } = args;
	const messages = args.messages ?? [];
	const leafId = args.leafId ?? null;
	const initialThinkingLevel = args.initialThinkingLevel ?? null;

	const earlyRunner = extensionRunner();
	const extensionProfiles = earlyRunner ? earlyRunner.getSubagentProfiles() : [];
	const artifacts = await loadProjectArtifacts(config, cwd, sessionId, deps.subagentService, extensionProfiles);
	const {
		builtinTools,
		projectCommands,
		skills,
		subagentProfiles,
		contextFiles,
		projectSettingsResult,
		globalSettingsResult,
		mergedFileSettings,
	} = artifacts;

	const resolvedModel =
		args.model ??
		(await modelRegistry.resolveSessionModel(await modelRegistry.pickDefaultModelIdOrNull(mergedFileSettings)));
	const runner = earlyRunner;
	const tools = runner ? mergeTools(builtinTools, runner.getTools()) : builtinTools;
	const commands = runner ? mergeCommands(projectCommands, runner.getCommands()) : projectCommands;

	const resolvedMode = resolveInitialMode(config, mergedFileSettings, args.initialMode ?? null);
	const { prompt: composedSystemPrompt, resolvedAppend } = composeSystemPrompt(config, {
		tools,
		mergedFileSettings,
		contextFiles,
		skills,
		cwd,
		mode: resolvedMode,
	});
	const effectiveCompaction: CompactionSettings = {
		...DEFAULT_COMPACTION_SETTINGS,
		...(mergedFileSettings.compaction ?? {}),
		...(config.compaction ?? {}),
	};
	const requestedThinking: ModelThinkingLevel =
		initialThinkingLevel ?? config.defaultThinkingLevel ?? mergedFileSettings.defaultThinkingLevel ?? "off";
	const resolvedThinkingLevel = resolvedModel ? clampThinkingLevel(resolvedModel, requestedThinking) : "off";
	const retryOptions = resolveProviderStreamOptions(resolvedModel?.provider ?? "openai", mergedFileSettings);
	const approvalTimeoutMs = mergedFileSettings.permission?.approvalTimeoutMs ?? 30000;

	const piAgent = createPiAgent(
		{
			events,
			sessions,
			modelRegistry,
			compactionOrchestrator,
			permissionService: deps.permissionService,
			appendEntry: deps.appendEntry,
		},
		{
			sessionId,
			model: resolvedModel,
			messages,
			tools,
			systemPrompt: composedSystemPrompt,
			thinkingLevel: resolvedThinkingLevel,
			retryOptions,
		},
	);

	sessions.set(sessionId, {
		cwd,
		tools,
		commands,
		projectCommands,
		skills,
		subagentProfiles,
		appendSystemPrompt: resolvedAppend ?? null,
		contextFiles,
		compaction: effectiveCompaction,
		retryOptions,
		settings: {
			projectSettings: projectSettingsResult.settings,
			projectSettingsPresent: projectSettingsResult.present,
			globalSettings: globalSettingsResult ? globalSettingsResult.settings : null,
			globalSettingsPresent: globalSettingsResult?.present ?? false,
			...(globalSettingsResult?.parseError !== undefined
				? { globalSettingsParseError: globalSettingsResult.parseError }
				: {}),
			...(projectSettingsResult.parseError !== undefined
				? { projectSettingsParseError: projectSettingsResult.parseError }
				: {}),
			sessionOverrides: {},
		},
		runtime: {
			piAgent,
			currentModelId: resolvedModel?.id ?? null,
			thinkingLevel: resolvedThinkingLevel,
			pendingThinkingLevelChange: false,
			cancelled: false,
			leafId,
			overflowRecoveryAttempted: false,
			subagentDepth: 0,
			mode: resolvedMode,
			pendingApprovals: new Map(),
			permissionGrants: new Map(),
			approvalTimeoutMs,
		},
	});
}

/**
 * Default-mode resolution chain:
 *   restored (rehydrate path) → config.defaultMode → settings.defaultMode → "ask"
 *
 * `allow-all` requires the host to opt-in via the matching capability:
 *   - `config.defaultMode = "allow-all"` requires both `allowsAllowAllMode` AND
 *     `allowsAllowAllModeAsDefault` (factory-time programmer error; caller already
 *     threw at agent construction).
 *   - `settings.defaultMode = "allow-all"` requires `allowsAllowAllModeAsDefault`.
 *     When the capability is off, log and fall through.
 *   - A restored persisted `allow-all` from session history requires `allowsAllowAllMode`.
 *     When the capability is off, log and fall through.
 *
 * Unknown / invalid settings values log a warning and fall through.
 */
function resolveInitialMode(
	config: BodhiPiConfig,
	merged: BodhiPiProjectSettings,
	restored: AgentMode | null,
): AgentMode {
	const logger = config.logger ?? console;
	const allowsAllowAll = config.allowsAllowAllMode === true;
	const allowsAllowAllAsDefault = config.allowsAllowAllModeAsDefault === true;
	if (restored !== null) {
		if (restored === "allow-all" && !allowsAllowAll) {
			logger.warn(
				`[bodhi-pi] persisted mode "allow-all" downgraded; host capability allowsAllowAllMode is disabled`,
			);
		} else {
			return restored;
		}
	}
	if (config.defaultMode !== undefined) return config.defaultMode;
	const fromSettings = merged.defaultMode;
	if (fromSettings !== undefined) {
		if (!isAgentMode(fromSettings)) {
			logger.warn(`[bodhi-pi] settings.defaultMode invalid value "${String(fromSettings)}" — falling back`);
		} else if (fromSettings === "allow-all" && !allowsAllowAllAsDefault) {
			logger.error(
				`[bodhi-pi] settings.defaultMode="allow-all" rejected; host capability allowsAllowAllModeAsDefault is disabled`,
			);
		} else {
			return fromSettings;
		}
	}
	return DEFAULT_AGENT_MODE;
}

/**
 * Rehydrate a previously-persisted session: load entries, walk the path, restore the model,
 * and rebuild the SessionState. Throws -32602 if the session id is unknown.
 */
export async function rehydrateSession(
	deps: BootstrapDeps,
	sessionId: string,
	cwd: string,
): Promise<{
	entries: NonNullable<Awaited<ReturnType<SessionStore["load"]>>>["entries"];
	currentModelId: string | null;
	mcpInclusion: string[] | null;
}> {
	const record = await deps.config.sessionStore.load(sessionId);
	if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);

	const ctx = buildSessionContext(record);
	const leafId =
		record.leafId !== undefined
			? record.leafId
			: record.entries.length > 0
				? record.entries[record.entries.length - 1].id
				: null;
	const requested = ctx.currentModelId ?? deps.config.defaultModelId ?? null;
	const restoredModel = requested ? await deps.modelRegistry.resolveSessionModel(requested) : null;
	await buildSessionState(deps, {
		sessionId,
		model: restoredModel,
		cwd,
		messages: ctx.messages,
		leafId,
		initialThinkingLevel: ctx.currentThinkingLevel,
		initialMode: ctx.currentMode,
	});
	return {
		entries: record.entries,
		currentModelId: restoredModel?.id ?? null,
		mcpInclusion: ctx.mcpInclusion,
	};
}
