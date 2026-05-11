import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BodhiPiEvent, BodhiPiEventHandlers } from "@bodhiapp/bodhi-pi";
import { defaultDbPath } from "@bodhiapp/bodhi-pi-node";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getEnvApiKey, getModels, getProviders } from "@earendil-works/pi-ai";

export interface ResolvedConfig {
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	dbPath: string;
	cwd: string;
	loadExtensions: boolean;
	eventHandlers?: BodhiPiEventHandlers;
}

function parseArgs(argv: string[]): Record<string, string | true> {
	const args: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next && !next.startsWith("--")) {
				args[key] = next;
				i++;
			} else {
				args[key] = true;
			}
		}
	}
	return args;
}

export function resolveConfig(argv: string[]): ResolvedConfig {
	const args = parseArgs(argv);

	if (args.help || args.h) {
		printHelp();
		process.exit(0);
	}

	if (args.version || args.v) {
		process.stdout.write("0.0.1\n");
		process.exit(0);
	}

	const allModels: Model<Api>[] = getProviders().flatMap((p) => getModels(p) as Model<Api>[]);

	const getApiKey = (provider: string): string | undefined => getEnvApiKey(provider);

	// Only expose models whose provider has a key — prevents routing to providers
	// like azure-openai-responses that share model ids with openai.
	const modelsWithKey = allModels.filter((m) => !!getApiKey(m.provider));

	if (modelsWithKey.length === 0) {
		const knownVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"];
		process.stderr.write(`Error: no API key found. Set one of: ${knownVars.join(", ")}\n`);
		process.exit(1);
	}

	const modelArg = typeof args.model === "string" ? args.model : undefined;
	const modelEnv = process.env.BODHI_MODEL;
	const requestedId = modelArg ?? modelEnv;

	let defaultModelId: string;
	if (requestedId) {
		const found = modelsWithKey.find((m) => m.id === requestedId);
		if (!found) {
			const ids = modelsWithKey.map((m) => m.id).join(", ");
			process.stderr.write(`Error: model "${requestedId}" not available. Available: ${ids}\n`);
			process.exit(1);
		}
		defaultModelId = found.id;
	} else {
		defaultModelId = modelsWithKey[0].id;
	}

	let systemPrompt: string | undefined;
	if (typeof args["system-prompt"] === "string") {
		systemPrompt = args["system-prompt"];
	} else if (typeof args["system-prompt-file"] === "string") {
		systemPrompt = fs.readFileSync(args["system-prompt-file"], "utf-8");
	} else if (process.env.BODHI_SYSTEM_PROMPT) {
		systemPrompt = process.env.BODHI_SYSTEM_PROMPT;
	}

	let appendSystemPrompt: string | undefined;
	if (typeof args["append-system-prompt"] === "string") {
		appendSystemPrompt = args["append-system-prompt"];
	} else if (process.env.BODHI_APPEND_SYSTEM_PROMPT) {
		appendSystemPrompt = process.env.BODHI_APPEND_SYSTEM_PROMPT;
	}

	const dbPath =
		typeof args.db === "string" ? path.resolve(args.db.replace(/^~/, os.homedir())) : defaultDbPath("bodhi-pi-cli");

	let cwd = process.cwd();
	if (typeof args.cwd === "string") {
		const resolved = path.resolve(args.cwd.replace(/^~/, os.homedir()));
		if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
			process.stderr.write(`Error: --cwd "${args.cwd}" is not an existing directory\n`);
			process.exit(1);
		}
		cwd = resolved;
	}

	const loadExtensions = !args["no-extensions"];

	const debugEvents = args["debug-events"] === true || process.env.BODHI_DEBUG_EVENTS === "1";
	const eventHandlers = debugEvents ? buildDebugEventHandlers() : undefined;

	return {
		models: modelsWithKey,
		defaultModelId,
		getApiKey,
		systemPrompt,
		appendSystemPrompt,
		dbPath,
		cwd,
		loadExtensions,
		...(eventHandlers ? { eventHandlers } : {}),
	};
}

/**
 * Print one-line stderr diagnostics per lifecycle event when `--debug-events` /
 * `BODHI_DEBUG_EVENTS=1` is on. Stays on stderr so REPL stdout (model text,
 * tool cards) remains clean and pipe-safe.
 */
function buildDebugEventHandlers(): BodhiPiEventHandlers {
	const log = (event: BodhiPiEvent) => {
		const sid = "sessionId" in event ? String(event.sessionId).slice(0, 8) : "—";
		let extra = "";
		if (event.type === "tool_call" || event.type === "tool_result") extra = ` tool=${event.toolName}`;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end")
			extra = ` tool=${event.toolName}`;
		if (event.type === "agent_start") extra = ` prompt=${JSON.stringify(event.userPrompt.slice(0, 40))}`;
		if (event.type === "agent_end" && event.stopReason !== undefined) extra = ` stop=${event.stopReason}`;
		if (event.type === "model_select") extra = ` ${event.fromModelId}→${event.toModelId}`;
		process.stderr.write(`[event] ${event.type} sid=${sid}${extra}\n`);
	};
	const types = [
		"session_start",
		"session_shutdown",
		"agent_start",
		"agent_end",
		"turn_start",
		"turn_end",
		"message_start",
		"message_update",
		"message_end",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
		"input",
		"before_agent_start",
		"before_provider_request",
		"after_provider_response",
		"tool_call",
		"tool_result",
		"model_select",
	] as const;
	const handlers: BodhiPiEventHandlers = {};
	for (const t of types) {
		(handlers as Record<string, Array<(e: BodhiPiEvent) => void>>)[t] = [log];
	}
	return handlers;
}

function printHelp(): void {
	process.stdout.write(`bodhi-pi-cli — interactive REPL for testing bodhi-pi

Usage: bodhi-pi-cli [options]

Options:
  --model <id>                   Model to use (default: first model with an API key)
  --system-prompt <text>         System prompt for the agent (replaces built-in)
  --system-prompt-file <path>    Read system prompt from file
  --append-system-prompt <text>  Append text to the system prompt (keeps tool descriptions)
  --db <path>                    SQLite DB path (default: ~/.bodhi-pi-cli/sessions.db)
  --cwd <path>                   Working directory for FS tools (default: process.cwd())
  --no-extensions                Skip auto-loading <cwd>/.bodhi-pi/extensions/*.{js,mjs,cjs}
  --debug-events                 Print one-line stderr diagnostics per lifecycle event
  --help, -h                     Show this help
  --version, -v                  Show version

Environment:
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.
  BODHI_MODEL                  Default model id
  BODHI_SYSTEM_PROMPT          System prompt text (replaces built-in)
  BODHI_APPEND_SYSTEM_PROMPT   Appended to system prompt (keeps tool descriptions)
  BODHI_DEBUG_EVENTS=1         Same as --debug-events

REPL commands:
  /help             List commands
  /new              Start a new session
  /sessions         List sessions for current cwd
  /resume <id>      Resume a previous session (replays history)
  /close            Close the current session (data persists)
  /delete <id>      Permanently delete a session
  /model <id>       Switch model for current session
  /quit             Exit
`);
}
