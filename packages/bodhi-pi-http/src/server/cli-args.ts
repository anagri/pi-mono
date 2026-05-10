import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CliArgs {
	port?: number;
	workspace?: string;
	dataDir?: string;
}

const KNOWN_FLAGS = new Set(["port", "workspace", "data-dir", "help", "h"]);

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

	return out;
}

function helpText(): string {
	return `bodhi-pi-http — HTTP+SSE-hosted reference client for bodhi-pi

Usage: bodhi-pi-http [options]

Options:
  --port <n>            TCP port to bind. Use 0 for a random free port. Default: env PORT or 3000.
  --workspace <dir>     Use <dir> as the agent's cwd for ALL connections (single-tenant test mode).
                        When omitted, each user gets <dataDir>/users/<id>/workspace/.
  --data-dir <dir>      Server data directory (sessions.db + per-user workspaces).
                        Default: env BODHI_PI_HTTP_DATA_DIR or ./.bodhi-pi-http.
  -h, --help            Show this help.

Environment:
  PORT                          Same as --port.
  BODHI_PI_HTTP_DATA_DIR        Same as --data-dir.
  OPENAI_API_KEY                Required for openai/gpt-4o-mini.
  ANTHROPIC_API_KEY             Optional; enables anthropic/claude-haiku-4-5.
`;
}
