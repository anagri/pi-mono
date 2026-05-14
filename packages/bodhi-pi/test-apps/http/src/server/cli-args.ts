import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliArgs {
	port?: number;
	workspace?: string;
	dataDir?: string;
	models?: string;
	defaultModel?: string;
}

const KNOWN_FLAGS = new Set(["port", "workspace", "data-dir", "models", "default-model", "help", "h"]);

export function parseArgs(argv: readonly string[]): CliArgs {
	const args: Record<string, string | true> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--") && arg !== "-h") continue;
		const key = arg === "-h" ? "h" : arg.slice(2);
		if (!KNOWN_FLAGS.has(key)) {
			throw new Error(`unknown flag: ${arg}`);
		}
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--") && next !== "-h") {
			args[key] = next;
			i++;
		} else {
			args[key] = true;
		}
	}

	if (args.help || args.h) {
		process.stdout.write(helpText());
		process.exit(0);
	}

	const out: CliArgs = {};

	if (typeof args.port === "string") {
		const n = Number(args.port);
		if (!Number.isInteger(n) || n < 0 || n > 65535) {
			throw new Error(`--port must be an integer in [0, 65535], got "${args.port}"`);
		}
		out.port = n;
	}

	if (typeof args.workspace === "string") {
		const resolved = path.resolve(args.workspace.replace(/^~/, os.homedir()));
		if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
			throw new Error(`--workspace "${args.workspace}" is not an existing directory`);
		}
		out.workspace = resolved;
	}

	if (typeof args["data-dir"] === "string") {
		out.dataDir = path.resolve(args["data-dir"].replace(/^~/, os.homedir()));
	}

	if (typeof args.models === "string") {
		out.models = args.models;
	}

	if (typeof args["default-model"] === "string") {
		out.defaultModel = args["default-model"];
	}

	return out;
}

function helpText(): string {
	return `bodhi-pi-test-app-http — HTTP+SSE-hosted test-app for bodhi-pi e2e

Usage: bodhi-pi-test-app-http [options]

Options:
  --port <n>            TCP port to bind. Use 0 for a random free port. Default: env PORT or 3000.
  --workspace <dir>     Use <dir> as the agent's cwd for ALL connections (single-tenant test mode).
                        When omitted, each user gets <dataDir>/users/<id>/workspace/.
  --data-dir <dir>      Server data directory (sessions.db + per-user workspaces).
                        Default: ./.bodhi-pi-http.
  --models <list>       Comma-separated provider:modelId pairs to pre-register at boot.
                        Example: --models openai:gpt-4o-mini,anthropic:claude-haiku-4-5-20251001
  --default-model <id>  Default model id used by new sessions when set.
  -h, --help            Show this help.

Environment:
  PORT                          Same as --port.
  OPENAI_API_KEY                Used as fallback by env-based getApiKey (test-only).
  ANTHROPIC_API_KEY             Same.
  GOOGLE_API_KEY / GROQ_API_KEY / XAI_API_KEY / CEREBRAS_API_KEY  Same.

Auth: clients populate the server's KvStore via /login <provider> <api-key>; env keys
above are a test-only convenience that lets the spawned server boot with model access
without an explicit /login step.
`;
}
