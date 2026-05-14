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
	createNodeKvStore,
	createNodeScriptExecutor,
	createSingleTenantSqliteSessionStore as createSqliteSessionStore,
} from "@e2e/app-utils/cli/index.js";
import { createNodeFilesystem } from "@e2e/helpers/node-adapters/index.js";
import { pickDefined } from "@e2e/helpers/pick-defined.js";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface CliAgentOptions {
	cwd: string;
	dbPath: string;
	/** Host-additive models (for non-pi-ai providers like local Ollama). Optional. */
	models?: Model<Api>[];
	defaultModelId?: string;
	/** Optional fallback below kvStore. Tests use it; production CLI doesn't. */
	getApiKey?: (provider: string) => string | undefined;
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
}

export function createCliAgent(opts: CliAgentOptions): CliAgent {
	const filesystem = createNodeFilesystem({ rootCwd: opts.cwd });
	// Global settings live outside the cwd jail, so the agent gets a separate root-filesystem.
	const globalFilesystem = opts.homeDir ? createNodeFilesystem({ rootCwd: "/" }) : undefined;
	const sessionStore = createSqliteSessionStore({ dbPath: opts.dbPath });
	const kvDir = opts.kvDir ?? (opts.homeDir ? path.join(opts.homeDir, ".bodhi-pi-cli", "kv") : undefined);
	const kvStore = createNodeKvStore(kvDir ? { dir: kvDir } : {});
	const factory = createBodhiPiAgent({
		sessionStore,
		filesystem,
		kvStore,
		scriptExecutor: createNodeScriptExecutor(),
		...pickDefined({
			models: opts.models,
			defaultModelId: opts.defaultModelId,
			getApiKey: opts.getApiKey,
			systemPrompt: opts.systemPrompt,
			appendSystemPrompt: opts.appendSystemPrompt,
			eventHandlers: opts.eventHandlers,
			extensionFactories: opts.extensionFactories,
			homeDir: opts.homeDir,
			globalFilesystem,
		}),
	});
	return { factory, sessionStore, filesystem, kvStore, cwd: opts.cwd };
}
