import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultDbPath } from "@bodhiapp/bodhi-pi-node";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getEnvApiKey, getModels, getProviders } from "@mariozechner/pi-ai";

export interface ResolvedConfig {
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	systemPrompt?: string;
	dbPath: string;
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

	const dbPath =
		typeof args.db === "string" ? path.resolve(args.db.replace(/^~/, os.homedir())) : defaultDbPath("bodhi-pi-cli");

	return { models: modelsWithKey, defaultModelId, getApiKey, systemPrompt, dbPath };
}

function printHelp(): void {
	process.stdout.write(`bodhi-pi-cli — interactive REPL for testing bodhi-pi

Usage: bodhi-pi-cli [options]

Options:
  --model <id>                   Model to use (default: first model with an API key)
  --system-prompt <text>         System prompt for the agent
  --system-prompt-file <path>    Read system prompt from file
  --db <path>                    SQLite DB path (default: ~/.bodhi-pi-cli/sessions.db)
  --help, -h                     Show this help
  --version, -v                  Show version

Environment:
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.
  BODHI_MODEL       Default model id
  BODHI_SYSTEM_PROMPT  System prompt text

REPL commands:
  /help             List commands
  /new              Start a new session
  /sessions         List sessions for current cwd
  /resume <id>      Resume a previous session (replays history)
  /model <id>       Switch model for current session
  /quit             Exit
`);
}
