import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { BootstrapDeps } from "@/sessions/session-bootstrap.js";
import { createPiAgent } from "@/sessions/session-bootstrap.js";
import type { SessionState } from "@/sessions/session-state.js";
import { BUILTIN_TOOL_SNIPPETS, createBuiltinTools } from "@/tools/index.js";
import { composeSubagentSystemPrompt } from "./system-prompt.js";
import type { SubagentProfile } from "./types.js";

export interface BuildChildSessionStateArgs {
	childSessionId: string;
	parentSessionState: SessionState;
	profile: SubagentProfile;
	leafId: string;
	depth: number;
	modelOverride?: string;
	messages?: AgentMessage[];
}

export async function buildChildSessionState(deps: BootstrapDeps, args: BuildChildSessionStateArgs): Promise<void> {
	const { config, sessions, modelRegistry, events, compactionOrchestrator, permissionService, appendEntry } = deps;
	const cwd = args.parentSessionState.cwd;

	const requestedModelId =
		args.profile.model ?? args.modelOverride ?? args.parentSessionState.runtime.currentModelId ?? null;
	const model = requestedModelId ? await modelRegistry.resolveSessionModel(requestedModelId) : null;

	const allBuiltins = createBuiltinTools({
		filesystem: config.filesystem,
		cwd,
		...(config.scriptExecutor ? { scriptExecutor: config.scriptExecutor } : {}),
		...(config.terminal ? { terminal: config.terminal } : {}),
	});
	const tools = args.profile.tools ? allBuiltins.filter((t) => args.profile.tools!.includes(t.name)) : allBuiltins;

	const systemPrompt = composeSubagentSystemPrompt({
		profile: args.profile,
		selectedTools: tools.map((t) => t.name),
		toolSnippets: BUILTIN_TOOL_SNIPPETS,
		cwd,
	});

	const requestedThinking = args.parentSessionState.runtime.thinkingLevel ?? "off";
	const resolvedThinkingLevel = model ? clampThinkingLevel(model, requestedThinking) : "off";
	const retryOptions = { ...args.parentSessionState.retryOptions };

	const piAgent = createPiAgent(
		{ events, sessions, modelRegistry, compactionOrchestrator, permissionService, appendEntry },
		{
			sessionId: args.childSessionId,
			model,
			messages: args.messages ?? [],
			tools,
			systemPrompt,
			thinkingLevel: resolvedThinkingLevel,
			retryOptions,
		},
	);

	sessions.set(args.childSessionId, {
		cwd,
		tools,
		commands: [],
		projectCommands: [],
		skills: [],
		subagentProfiles: [],
		appendSystemPrompt: null,
		contextFiles: [],
		compaction: args.parentSessionState.compaction,
		retryOptions,
		settings: {
			projectSettings: args.parentSessionState.settings.projectSettings,
			projectSettingsPresent: args.parentSessionState.settings.projectSettingsPresent,
			globalSettings: args.parentSessionState.settings.globalSettings,
			globalSettingsPresent: args.parentSessionState.settings.globalSettingsPresent,
			...(args.parentSessionState.settings.projectSettingsParseError !== undefined
				? { projectSettingsParseError: args.parentSessionState.settings.projectSettingsParseError }
				: {}),
			...(args.parentSessionState.settings.globalSettingsParseError !== undefined
				? { globalSettingsParseError: args.parentSessionState.settings.globalSettingsParseError }
				: {}),
			sessionOverrides: {},
		},
		runtime: {
			piAgent,
			currentModelId: model?.id ?? null,
			thinkingLevel: resolvedThinkingLevel,
			pendingThinkingLevelChange: false,
			cancelled: false,
			leafId: args.leafId,
			overflowRecoveryAttempted: false,
			subagentDepth: args.depth,
			mode: args.parentSessionState.runtime.mode,
			pendingApprovals: new Map(),
			permissionGrants: new Map(),
			approvalTimeoutMs: args.parentSessionState.runtime.approvalTimeoutMs,
		},
	});
}
