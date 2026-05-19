#!/usr/bin/env node
import os from "node:os";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, type BodhiPiEventHandlers, LIFECYCLE_EVENT_METHOD } from "@bodhiapp/bodhi-pi";
import { createNodePackageExtensionLoader } from "@bodhiapp/bodhi-pi-test-app-node-adapters";
import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
// seam-exception: cli binary entry constructs both AgentSideConnection (Host) and the in-process Client peer (REPL/headless). The REPL imports are the second-half bootstrap; splitting cli.ts into a Host-only entry + a separate Client-only entry would require two npm `bin` entries and is out of scope for the folder split.
import { runHeadless } from "../client/acp/headless.js";
// seam-exception: see comment above runHeadless import.
import { runRepl } from "../client/acp/repl.js";
import { createCliAgent } from "./agent.js";
import { resolveConfig } from "./config.js";
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
	"tool_blocked",
	"subagent_start",
	"subagent_end",
] as const;

/**
 * In `--rpc` mode the spawning harness pipes stderr and parses it as the event
 * channel. Stdout stays pure ACP. Each event is one JSON-RPC notification per
 * line — same frame shape as the http SSE channel — so the harness uses one
 * canonical parser per channel.
 */
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

const argv = process.argv.slice(2);
const isRpc = argv.includes("--rpc");
const isHeadless = argv.includes("--headless");

// Parse --models and --default-model out of argv before passing the rest to
// resolveConfig (which doesn't know these args). Format: --models openai:gpt-4o-mini,anthropic:claude-haiku-4-5-20251001
function popArgValue(args: string[], flag: string): { value: string | undefined; rest: string[] } {
	const idx = args.indexOf(flag);
	if (idx === -1) return { value: undefined, rest: args };
	const value = args[idx + 1];
	return { value, rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

let rest = argv.filter((a) => a !== "--rpc" && a !== "--headless");
const { value: modelsArg, rest: rest1 } = popArgValue(rest, "--models");
rest = rest1;
const { value: defaultModelArg, rest: rest2 } = popArgValue(rest, "--default-model");
rest = rest2;

const models: Model<Api>[] = [];
if (modelsArg) {
	for (const pair of modelsArg.split(",")) {
		const [provider, modelId] = pair.split(":");
		if (!provider || !modelId) {
			process.stderr.write(`[bodhi-pi-test-app-cli] invalid --models entry: ${pair}\n`);
			process.exit(1);
		}
		// getModel is heavily typed; the dynamic provider/modelId pair from CLI input
		// can't satisfy its overloads, so we cast through unknown.
		const m = (getModel as unknown as (p: string, id: string) => Model<Api> | undefined)(provider, modelId);
		if (!m) {
			process.stderr.write(`[bodhi-pi-test-app-cli] unknown model: ${pair}\n`);
			process.exit(1);
		}
		models.push(m);
	}
}

// Map provider → conventional env var. Used as the default getApiKey for the
// test-app, so tests can spawn the cli with API keys inherited from the env
// without going through /login. Production bodhi-pi-cli does NOT do this —
// only the test-app needs it.
const PROVIDER_ENV: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GOOGLE_API_KEY",
	groq: "GROQ_API_KEY",
	xai: "XAI_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
};

function envGetApiKey(provider: string): string | undefined {
	const envName = PROVIDER_ENV[provider];
	if (!envName) return undefined;
	return process.env[envName];
}

const cfg = resolveConfig(rest);
const cwd = cfg.cwd;

const extensionFactories = cfg.loadExtensions ? await createNodePackageExtensionLoader({ cwd }) : [];

// In --rpc mode the harness drives this binary over stdio and treats stderr as
// the event channel; install the stderr writer unless the user explicitly
// opted in to --debug-events for human-readable diagnostics.
const eventHandlers = cfg.eventHandlers ?? (isRpc ? buildStderrEventHandlers() : undefined);

const agent = createCliAgent({
	cwd,
	dbPath: cfg.dbPath,
	homeDir: os.homedir(),
	getApiKey: envGetApiKey,
	...(models.length > 0 ? { models } : {}),
	...(defaultModelArg !== undefined ? { defaultModelId: defaultModelArg } : {}),
	...(cfg.systemPrompt !== undefined ? { systemPrompt: cfg.systemPrompt } : {}),
	...(cfg.appendSystemPrompt !== undefined ? { appendSystemPrompt: cfg.appendSystemPrompt } : {}),
	...(eventHandlers ? { eventHandlers } : {}),
	...(extensionFactories.length > 0 ? { extensionFactories } : {}),
});

if (cfg.loadExtensions && extensionFactories.length > 0 && !isRpc) {
	process.stderr.write(`[bodhi-pi-test-app-cli] loaded ${extensionFactories.length} extension(s)\n`);
}

if (isRpc) {
	const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
	const stream = ndJsonStream(output, input);
	const conn = new AgentSideConnection(agent.factory, stream);
	void conn;
	await new Promise<void>((resolve) => process.stdin.once("end", resolve));
	process.exit(0);
}

if (isHeadless) {
	await runHeadless({ factory: agent.factory, cwd: agent.cwd, sessionStore: agent.sessionStore });
	process.exit(0);
}

await runRepl({ factory: agent.factory, cwd: agent.cwd, sessionStore: agent.sessionStore });
