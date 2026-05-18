import os from "node:os";
import path from "node:path";
import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";
import type { BodhiPiEventHandlers, RegisteredExtension, SessionStore } from "@bodhiapp/bodhi-pi";
import { createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createBashTerminal } from "./adapters/bash-terminal.js";
import { createNodeFilesystem } from "./adapters/node-filesystem.js";
import { createNodeKvStore } from "./adapters/node-kv-store.js";
import { pickDefined } from "./adapters/pick-defined.js";
import { createNodeScriptExecutor } from "./adapters/script-executor.js";
import { createSqliteSessionStore } from "./adapters/sessions/single-tenant/store.js";
import { defaultDbPath, defaultKvDir, homeDir as getHomeDir } from "./config.js";

export interface CodingAgentOptions {
	cwd: string;
	dbPath?: string;
	kvDir?: string;
	homeDir?: string;
	models?: Model<Api>[];
	defaultModelId?: string;
	getApiKey?: (provider: string) => string | undefined;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	eventHandlers?: BodhiPiEventHandlers;
	extensionFactories?: RegisteredExtension[];
}

export interface CodingAgent {
	factory: (conn: AgentSideConnection) => Agent;
	sessionStore: SessionStore;
	cwd: string;
}

export function createCodingAgent(opts: CodingAgentOptions): CodingAgent {
	const home = opts.homeDir ?? getHomeDir();
	const kvDir = opts.kvDir ?? defaultKvDir();
	const dbPath = opts.dbPath ?? defaultDbPath();

	const filesystem = createNodeFilesystem({ rootCwd: opts.cwd });
	const globalFilesystem = createNodeFilesystem({ rootCwd: "/" });
	const sessionStore = createSqliteSessionStore({ dbPath });
	const kvStore = createNodeKvStore(kvDir);
	const terminal = createBashTerminal();
	const scriptExecutor = createNodeScriptExecutor();

	const factory = createBodhiPiAgent({
		sessionStore,
		filesystem,
		globalFilesystem,
		homeDir: home,
		kvStore,
		terminal,
		scriptExecutor,
		...pickDefined({
			models: opts.models,
			defaultModelId: opts.defaultModelId,
			getApiKey: opts.getApiKey,
			systemPrompt: opts.systemPrompt,
			appendSystemPrompt: opts.appendSystemPrompt,
			eventHandlers: opts.eventHandlers,
			extensionFactories: opts.extensionFactories,
		}),
	});

	return { factory, sessionStore, cwd: opts.cwd };
}

export function envGetApiKey(provider: string): string | undefined {
	const PROVIDER_ENV: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		anthropic: "ANTHROPIC_API_KEY",
		google: "GOOGLE_API_KEY",
		groq: "GROQ_API_KEY",
		xai: "XAI_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
	};
	const envName = PROVIDER_ENV[provider];
	if (!envName) return undefined;
	return process.env[envName];
}

export function resolveHomeDir(): string {
	return os.homedir();
}

export function resolveCwd(cwdArg?: string): string {
	if (!cwdArg) return process.cwd();
	return path.resolve(cwdArg.replace(/^~/, os.homedir()));
}
