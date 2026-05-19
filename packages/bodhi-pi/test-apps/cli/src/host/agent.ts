import path from "node:path";
import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";
import type {
	BodhiPiEventHandlers,
	Filesystem,
	KvStore,
	RegisteredExtension,
	SessionStore,
} from "@bodhiapp/bodhi-pi";
import {
	createBashTerminal,
	createNodeFilesystem,
	createNodeKvStore,
	createNodeScriptExecutor,
	createSingleTenantSqliteSessionStore as createSqliteSessionStore,
} from "@bodhiapp/bodhi-pi-test-app-node-adapters";
import { createBodhiPiHostAgent } from "@bodhiapp/bodhi-pi-test-app-utils/host-agent";
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
	const factory = createBodhiPiHostAgent(
		{ sessionStore, filesystem },
		{
			kvStore,
			scriptExecutor: createNodeScriptExecutor(),
			terminal: createBashTerminal(),
			models: opts.models,
			defaultModelId: opts.defaultModelId,
			getApiKey: opts.getApiKey,
			systemPrompt: opts.systemPrompt,
			appendSystemPrompt: opts.appendSystemPrompt,
			eventHandlers: opts.eventHandlers,
			extensionFactories: opts.extensionFactories,
			homeDir: opts.homeDir,
			globalFilesystem,
			// Per ai-docs/specs/bodhi-pi/modes.md: PoCs demonstrate full mode feasibility.
			// allow-all is reachable via /mode allow-all; settings-side default still gated.
			allowsAllowAllMode: true,
			allowsAllowAllModeAsDefault: false,
		},
	);
	return { factory, sessionStore, filesystem, kvStore, cwd: opts.cwd };
}
