import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent, type Filesystem, type SessionStore } from "@bodhiapp/bodhi-pi";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createNodeFilesystem } from "./fs/node-filesystem.js";
import { createNodeScriptExecutor } from "./fs/node-script-executor.js";
import { createSqliteSessionStore } from "./sessions/sqlite-session-store.js";

export interface CliAgentOptions {
	cwd: string;
	dbPath: string;
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	systemPrompt?: string;
}

export interface CliAgent {
	factory: (conn: AgentSideConnection) => Agent;
	sessionStore: SessionStore;
	filesystem: Filesystem;
	cwd: string;
	models: Model<Api>[];
}

export function createCliAgent(opts: CliAgentOptions): CliAgent {
	const filesystem = createNodeFilesystem(opts.cwd);
	const sessionStore = createSqliteSessionStore(opts.dbPath);
	const factory = createBodhiPiAgent({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		getApiKey: opts.getApiKey,
		sessionStore,
		filesystem,
		scriptExecutor: createNodeScriptExecutor(),
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
	});
	return { factory, sessionStore, filesystem, cwd: opts.cwd, models: opts.models };
}
