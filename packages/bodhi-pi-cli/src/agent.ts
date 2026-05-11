import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";
import {
	type BodhiPiEventHandlers,
	createBodhiPiAgent,
	type Filesystem,
	type RegisteredExtension,
	type SessionStore,
} from "@bodhiapp/bodhi-pi";
import { createNodeFilesystem, createNodeScriptExecutor, createSqliteSessionStore } from "@bodhiapp/bodhi-pi-node";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface CliAgentOptions {
	cwd: string;
	dbPath: string;
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	eventHandlers?: BodhiPiEventHandlers;
	extensionFactories?: RegisteredExtension[];
}

export interface CliAgent {
	factory: (conn: AgentSideConnection) => Agent;
	sessionStore: SessionStore;
	filesystem: Filesystem;
	cwd: string;
	models: Model<Api>[];
}

export function createCliAgent(opts: CliAgentOptions): CliAgent {
	const filesystem = createNodeFilesystem({ rootCwd: opts.cwd });
	const sessionStore = createSqliteSessionStore({ dbPath: opts.dbPath });
	const factory = createBodhiPiAgent({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		getApiKey: opts.getApiKey,
		sessionStore,
		filesystem,
		scriptExecutor: createNodeScriptExecutor(),
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
		...(opts.eventHandlers ? { eventHandlers: opts.eventHandlers } : {}),
		...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
	});
	return { factory, sessionStore, filesystem, cwd: opts.cwd, models: opts.models };
}
