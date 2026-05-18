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
	type Terminal,
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
	terminal?: Terminal;
	eventHandlers?: BodhiPiEventHandlers;
	extensionFactories?: RegisteredExtension[];
	compaction?: Partial<CompactionSettings>;
	homeDir?: string;
	kvStore?: KvStore;
	defaultThinkingLevel?: ModelThinkingLevel;
	supportsMcpStdio?: boolean;
}

export interface TestHarness {
	clientConn: ReturnType<typeof createInProcessAcpPair>["clientConn"];
	updates: SessionNotification[];
	extNotifications: Array<{ method: string; params: unknown }>;
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
	const extNotifications: Array<{ method: string; params: unknown }> = [];
	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: opts.models,
			defaultModelId: opts.defaultModelId,
			// Default: provide a stub key only for providers that the host actually
			// supplied via `models[]` (so faux + custom baseUrl mocks pass an
			// Authorization header). Real-LLM tests override this explicitly.
			getApiKey:
				opts.getApiKey ??
				((provider) => ((opts.models ?? []).some((m) => m.provider === provider) ? "test-key" : undefined)),
			sessionStore,
			filesystem,
			kvStore,
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
			...(opts.scriptExecutor ? { scriptExecutor: opts.scriptExecutor } : {}),
			...(opts.terminal ? { terminal: opts.terminal } : {}),
			...(opts.eventHandlers ? { eventHandlers: opts.eventHandlers } : {}),
			...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
			...(opts.compaction ? { compaction: opts.compaction } : {}),
			...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
			...(opts.defaultThinkingLevel !== undefined ? { defaultThinkingLevel: opts.defaultThinkingLevel } : {}),
			...(opts.supportsMcpStdio !== undefined ? { supportsMcpStdio: opts.supportsMcpStdio } : {}),
		}),
		() => ({
			sessionUpdate: async (params) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			extNotification: async (method, params) => {
				extNotifications.push({ method, params });
			},
		}),
	);
	return { clientConn, updates, extNotifications, filesystem, sessionStore, kvStore };
}
