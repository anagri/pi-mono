import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { BodhiPiEvent, BodhiPiEventHandlers } from "@bodhiapp/bodhi-pi";
import { LIFECYCLE_EVENT_METHOD } from "@bodhiapp/bodhi-pi";
import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import { runInteractiveMode } from "../client/modes/interactive/interactive-mode.js";
import { runPrintMode } from "../client/modes/print-mode.js";
import { createNodePackageExtensionLoader } from "./adapters/extension-loader.js";
import { createCodingAgent, envGetApiKey } from "./agent.js";
import { defaultDbPath } from "./config.js";

const ALL_EVENT_TYPES = [
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
	"auth_change",
	"settings_change",
	"compaction_start",
	"compaction_end",
	"branch_summary_created",
	"session_navigate",
	"session_fork",
	"session_clone",
] as const;

function buildStderrEventHandlers(): BodhiPiEventHandlers {
	const post = (event: BodhiPiEvent): undefined => {
		process.stderr.write(`${JSON.stringify({ jsonrpc: "2.0", method: LIFECYCLE_EVENT_METHOD, params: event })}\n`);
		return undefined;
	};
	const handlers: BodhiPiEventHandlers = {};
	for (const t of ALL_EVENT_TYPES) {
		(handlers as Record<string, Array<(e: BodhiPiEvent) => undefined>>)[t] = [post];
	}
	return handlers;
}

function buildDebugEventHandlers(): BodhiPiEventHandlers {
	const log = (event: BodhiPiEvent) => {
		const sid = "sessionId" in event ? String(event.sessionId).slice(0, 8) : "—";
		process.stderr.write(`[event] ${event.type} sid=${sid}\n`);
	};
	const handlers: BodhiPiEventHandlers = {};
	for (const t of ALL_EVENT_TYPES) {
		(handlers as Record<string, Array<(e: BodhiPiEvent) => void>>)[t] = [log];
	}
	return handlers;
}

function popArgValue(args: string[], flag: string): { value: string | undefined; rest: string[] } {
	const idx = args.indexOf(flag);
	if (idx === -1) return { value: undefined, rest: args };
	const value = args[idx + 1];
	return { value, rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

function parseFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function printHelp(): void {
	process.stdout.write(`bodhi-pi — CLI coding agent powered by bodhi-pi

Usage: bodhi-pi [options] [message]

Options:
  --cwd <path>                   Working directory (default: process.cwd())
  --db <path>                    SQLite session DB path
  --models <provider:id,...>     Comma-separated model list (e.g. openai:gpt-4o)
  --default-model <id>           Default model to use
  --system-prompt <text>         Override system prompt
  --system-prompt-file <path>    Read system prompt from file
  --append-system-prompt <text>  Append text to system prompt
  --print                        Non-interactive print mode
  --rpc                          JSON-RPC over stdio mode
  --no-extensions                Skip auto-loading extensions
  --debug-events                 Print lifecycle events to stderr
  --help, -h                     Show this help

  message                        Send this message and exit (implies --print)
`);
}

export async function runCli(argv: string[]): Promise<void> {
	let args = argv;

	if (parseFlag(args, "--help") || parseFlag(args, "-h")) {
		printHelp();
		process.exit(0);
	}

	const isRpc = parseFlag(args, "--rpc");
	const isPrint = parseFlag(args, "--print");
	const noExtensions = parseFlag(args, "--no-extensions");
	const debugEvents = parseFlag(args, "--debug-events");

	args = args.filter((a) => !["--rpc", "--print", "--no-extensions", "--debug-events"].includes(a));

	const { value: cwdArg, rest: r1 } = popArgValue(args, "--cwd");
	args = r1;
	const { value: dbArg, rest: r2 } = popArgValue(args, "--db");
	args = r2;
	const { value: modelsArg, rest: r3 } = popArgValue(args, "--models");
	args = r3;
	const { value: defaultModelArg, rest: r4 } = popArgValue(args, "--default-model");
	args = r4;
	const { value: systemPromptArg, rest: r5 } = popArgValue(args, "--system-prompt");
	args = r5;
	const { value: systemPromptFileArg, rest: r6 } = popArgValue(args, "--system-prompt-file");
	args = r6;
	const { value: appendSystemPromptArg, rest: r7 } = popArgValue(args, "--append-system-prompt");
	args = r7;

	const initialMessage =
		args
			.filter((a) => !a.startsWith("--"))
			.join(" ")
			.trim() || undefined;

	let cwd = process.cwd();
	if (cwdArg) {
		const resolved = path.resolve(cwdArg.replace(/^~/, os.homedir()));
		if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
			process.stderr.write(`Error: --cwd "${cwdArg}" is not an existing directory\n`);
			process.exit(1);
		}
		cwd = resolved;
	}

	let systemPrompt: string | undefined = systemPromptArg;
	if (systemPromptFileArg) {
		systemPrompt = fs.readFileSync(systemPromptFileArg, "utf-8");
	}

	const dbPath = dbArg ? path.resolve(dbArg.replace(/^~/, os.homedir())) : defaultDbPath();

	const models: Model<Api>[] = [];
	if (modelsArg) {
		for (const pair of modelsArg.split(",")) {
			const [provider, modelId] = pair.split(":");
			if (!provider || !modelId) {
				process.stderr.write(`invalid --models entry: ${pair}\n`);
				process.exit(1);
			}
			const m = (getModel as unknown as (p: string, id: string) => Model<Api> | undefined)(provider, modelId);
			if (!m) {
				process.stderr.write(`unknown model: ${pair}\n`);
				process.exit(1);
			}
			models.push(m);
		}
	}

	const extensionFactories = noExtensions ? [] : await createNodePackageExtensionLoader({ cwd });

	const eventHandlers = isRpc ? buildStderrEventHandlers() : debugEvents ? buildDebugEventHandlers() : undefined;

	const agent = createCodingAgent({
		cwd,
		dbPath,
		homeDir: os.homedir(),
		getApiKey: envGetApiKey,
		...(models.length > 0 ? { models } : {}),
		...(defaultModelArg !== undefined ? { defaultModelId: defaultModelArg } : {}),
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
		...(appendSystemPromptArg !== undefined ? { appendSystemPrompt: appendSystemPromptArg } : {}),
		...(eventHandlers ? { eventHandlers } : {}),
		...(extensionFactories.length > 0 ? { extensionFactories } : {}),
	});

	if (isRpc) {
		const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
		const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
		const stream = ndJsonStream(output, input);
		const conn = new AgentSideConnection(agent.factory, stream);
		void conn;
		await new Promise<void>((resolve) => process.stdin.once("end", resolve));
		process.exit(0);
		return;
	}

	if (isPrint || initialMessage !== undefined) {
		await runPrintMode({ factory: agent.factory, cwd: agent.cwd, sessionStore: agent.sessionStore, initialMessage });
		process.exit(0);
		return;
	}

	await runInteractiveMode({ factory: agent.factory, cwd: agent.cwd, sessionStore: agent.sessionStore });
}
