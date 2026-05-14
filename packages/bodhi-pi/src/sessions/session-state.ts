import type { AgentTool, Agent as PiAgent } from "@earendil-works/pi-agent-core";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { PromptTemplate } from "@/commands/prompt-templates.js";
import type { BodhiPiProjectSettings } from "@/settings/settings.js";
import type { Skill } from "@/skills/skill.js";
import type { CompactionSettings } from "./compaction.js";
import type { ContextFile } from "./resource-loader.js";

/** Resolved per-provider stream options (retry + timeout) the session forwards into pi-ai. */
export interface ResolvedRetryOptions {
	maxRetries?: number;
	timeoutMs?: number;
	maxRetryDelayMs?: number;
}

/**
 * Three-layer settings snapshot read at session bootstrap. Mutated only by `handleSettings*`
 * (session-scope) and re-loaded into `projectSettings` / `globalSettings` after the corresponding
 * file write. `sessionOverrides` is in-memory only.
 */
export interface SettingsState {
	/** Global settings layer snapshot (Node hosts only); `null` when `BodhiPiConfig.homeDir` was omitted. */
	globalSettings: BodhiPiProjectSettings | null;
	projectSettings: BodhiPiProjectSettings;
	sessionOverrides: BodhiPiProjectSettings;
	projectSettingsPresent: boolean;
	globalSettingsPresent: boolean;
	projectSettingsParseError?: string;
	globalSettingsParseError?: string;
}

/**
 * Live runtime state owned by a single `prompt()` lifecycle. `currentModelId` is `null` until
 * the first auth-resolvable model is selected; `prompt()` rejects in that state.
 */
export interface SessionRuntime {
	piAgent: PiAgent;
	/** `null` when no auth-resolvable model exists at boot; `prompt()` rejects with a branched error message. */
	currentModelId: string | null;
	thinkingLevel: ModelThinkingLevel;
	pendingThinkingLevelChange: boolean;
	/** Set by `cancel()`; read by `prompt()` to return `stopReason: "cancelled"`. Reset before each prompt. */
	cancelled: boolean;
	/** Current head of the session DAG; `null` for a fresh session. Bumped on every entry append. */
	leafId: string | null;
	/** True after one auto-compact retry; reset at the start of each prompt() to allow per-turn recovery. */
	overflowRecoveryAttempted: boolean;
}

export interface SessionState {
	cwd: string;
	tools: AgentTool[];
	/**
	 * Effective commands list = `mergeCommands(projectCommands, extension-runner commands)`.
	 * Re-derived from `projectCommands` + the runner's current registry on every
	 * `refreshSlashable()` so runtime `pi.registerCommand(...)` mutations propagate.
	 */
	commands: PromptTemplate[];
	/** Project-discovered commands frozen at session hydration; combined with extension commands at refresh time. */
	projectCommands: PromptTemplate[];
	skills: Skill[];
	appendSystemPrompt: string | null;
	contextFiles: ContextFile[];
	/** Resolved per-session bits surfaced via `_bodhi-pi/session/config`. */
	compaction: CompactionSettings;
	retryOptions: ResolvedRetryOptions;
	settings: SettingsState;
	runtime: SessionRuntime;
}
