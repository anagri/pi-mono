import path from "node:path";
import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";
import {
	type BodhiPiEventHandlers,
	createBodhiPiAgent,
	type Filesystem,
	type KvStore,
	type RegisteredExtension,
	type SessionStore,
} from "@bodhiapp/bodhi-pi";
import {
	createNodeFilesystem,
	createNodeKvStore,
	createNodeScriptExecutor,
	createSqliteSessionStore,
} from "@bodhiapp/bodhi-pi-node";
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
	homeDir?: string;
	kvDir?: string;
}

export interface CliAgent {
	factory: (conn: AgentSideConnection) => Agent;
	sessionStore: SessionStore;
	filesystem: Filesystem;
	kvStore: KvStore;
	cwd: string;
	models: Model<Api>[];
}

export function createCliAgent(opts: CliAgentOptions): CliAgent {
	const filesystem = createNodeFilesystem({ rootCwd: opts.cwd });
	// Global settings live outside the cwd jail, so the agent gets a separate root-filesystem.
	const globalFilesystem = opts.homeDir ? createNodeFilesystem({ rootCwd: "/" }) : undefined;
	const sessionStore = createSqliteSessionStore({ dbPath: opts.dbPath });
	const kvDir = opts.kvDir ?? (opts.homeDir ? path.join(opts.homeDir, ".bodhi-pi-cli", "kv") : undefined);
	const kvStore = createNodeKvStore(kvDir ? { dir: kvDir } : {});
	const factory = createBodhiPiAgent({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		getApiKey: opts.getApiKey,
		sessionStore,
		filesystem,
		kvStore,
		scriptExecutor: createNodeScriptExecutor(),
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
		...(opts.eventHandlers ? { eventHandlers: opts.eventHandlers } : {}),
		...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
		...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
		...(globalFilesystem !== undefined ? { globalFilesystem } : {}),
	});
	return { factory, sessionStore, filesystem, kvStore, cwd: opts.cwd, models: opts.models };
}
