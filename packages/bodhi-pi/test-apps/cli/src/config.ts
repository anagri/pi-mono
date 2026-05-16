import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BodhiPiEvent, BodhiPiEventHandlers } from "@bodhiapp/bodhi-pi";
import { defaultDbPath } from "@bodhiapp/bodhi-pi-test-app-node-adapters";

export interface ResolvedConfig {
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

	let systemPrompt: string | undefined;
	if (typeof args["system-prompt"] === "string") {
		systemPrompt = args["system-prompt"];
	} else if (typeof args["system-prompt-file"] === "string") {
		systemPrompt = fs.readFileSync(args["system-prompt-file"], "utf-8");
	}

	let appendSystemPrompt: string | undefined;
	if (typeof args["append-system-prompt"] === "string") {
		appendSystemPrompt = args["append-system-prompt"];
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

	const debugEvents = args["debug-events"] === true;
	const eventHandlers = debugEvents ? buildDebugEventHandlers() : undefined;

	return {
		systemPrompt,
		appendSystemPrompt,
		dbPath,
		cwd,
		loadExtensions,
		...(eventHandlers ? { eventHandlers } : {}),
	};
}

/** One-line stderr diagnostics per lifecycle event, enabled by `--debug-events`. */
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
  --system-prompt <text>         System prompt for the agent (replaces built-in)
  --system-prompt-file <path>    Read system prompt from file
  --append-system-prompt <text>  Append text to the system prompt (keeps tool descriptions)
  --db <path>                    SQLite DB path (default: ~/.bodhi-pi-cli/sessions.db)
  --cwd <path>                   Working directory for FS tools (default: process.cwd())
  --no-extensions                Skip auto-loading <cwd>/.bodhi-pi/extensions/*.{js,mjs,cjs}
  --debug-events                 Print one-line stderr diagnostics per lifecycle event
  --help, -h                     Show this help
  --version, -v                  Show version

REPL commands:
  /help             List commands
  /new              Start a new session
  /sessions         List sessions for current cwd
  /resume <id>      Resume a previous session (replays history)
  /close            Close the current session (data persists)
  /delete <id>      Permanently delete a session
  /model <id>       Switch model for current session
  /login <provider> <api-key>   Store an API key (secret) for a provider
  /logout <provider>            Remove a stored API key
  /logins           List providers with stored auth (masked)
  /settings list|get|set|unset <key> <value> [--global|--project|--session]
  /quit             Exit
`);
}
