import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type BodhiPiEventHandlers,
	type CompactionSettings,
	createBodhiPiAgent,
	createInMemoryFilesystem,
	createInMemoryKvStore,
	createInMemorySessionStore,
	type Filesystem,
	type KvStore,
	type RegisteredExtension,
	type ScriptExecutor,
	type SessionStore,
} from "@/index.js";
import { createInProcessAcpPair } from "./in-process-connection.js";

export interface TestHarnessOptions {
	models: Parameters<typeof createBodhiPiAgent>[0]["models"];
	defaultModelId: string;
	getApiKey?: (provider: string) => string | undefined;
	sessionStore?: SessionStore;
	filesystem?: Filesystem;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	scriptExecutor?: ScriptExecutor;
	eventHandlers?: BodhiPiEventHandlers;
	extensionFactories?: RegisteredExtension[];
	compaction?: Partial<CompactionSettings>;
	homeDir?: string;
	kvStore?: KvStore;
	defaultThinkingLevel?: ModelThinkingLevel;
}

export interface TestHarness {
	clientConn: ReturnType<typeof createInProcessAcpPair>["clientConn"];
	updates: SessionNotification[];
	filesystem: Filesystem;
	sessionStore: SessionStore;
	kvStore: KvStore;
}

/** Single source of truth for ACP test wiring. Defaults storage to in-memory adapters. */
export function createTestHarness(opts: TestHarnessOptions): TestHarness {
	const filesystem = opts.filesystem ?? createInMemoryFilesystem();
	const sessionStore = opts.sessionStore ?? createInMemorySessionStore();
	const kvStore = opts.kvStore ?? createInMemoryKvStore();
	const updates: SessionNotification[] = [];
	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: opts.models,
			defaultModelId: opts.defaultModelId,
			getApiKey: opts.getApiKey ?? (() => "test-key"),
			sessionStore,
			filesystem,
			kvStore,
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
			...(opts.scriptExecutor ? { scriptExecutor: opts.scriptExecutor } : {}),
			...(opts.eventHandlers ? { eventHandlers: opts.eventHandlers } : {}),
			...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
			...(opts.compaction ? { compaction: opts.compaction } : {}),
			...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
			...(opts.defaultThinkingLevel !== undefined ? { defaultThinkingLevel: opts.defaultThinkingLevel } : {}),
		}),
		() => ({
			sessionUpdate: async (params) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		}),
	);
	return { clientConn, updates, filesystem, sessionStore, kvStore };
}
