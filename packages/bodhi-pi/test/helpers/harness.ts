import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
	createBodhiPiAgent,
	createInMemoryFilesystem,
	createInMemorySessionStore,
	type Filesystem,
	type ScriptExecutor,
	type SessionStore,
} from "../../src/index.js";
import { createInProcessAcpPair } from "./in-process-connection.js";

export interface TestHarness {
	clientConn: ReturnType<typeof createInProcessAcpPair>["clientConn"];
	updates: SessionNotification[];
	filesystem: Filesystem;
	sessionStore: SessionStore;
}

export interface TestHarnessOptions {
	models: Parameters<typeof createBodhiPiAgent>[0]["models"];
	defaultModelId: string;
	getApiKey?: (provider: string) => string | undefined;
	sessionStore?: SessionStore;
	filesystem?: Filesystem;
	systemPrompt?: string;
	scriptExecutor?: ScriptExecutor;
}

/**
 * Single source of truth for ACP test wiring.
 *
 * Returns a uniform `{ clientConn, updates, filesystem, sessionStore }` shape
 * for every test (integration + e2e). Defaults `sessionStore` and
 * `filesystem` to fresh in-memory implementations; tests pass either or
 * both when they need to share state across multiple harnesses (e.g.
 * session-replay tests).
 */
export function createTestHarness(opts: TestHarnessOptions): TestHarness {
	const filesystem = opts.filesystem ?? createInMemoryFilesystem();
	const sessionStore = opts.sessionStore ?? createInMemorySessionStore();
	const updates: SessionNotification[] = [];
	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: opts.models,
			defaultModelId: opts.defaultModelId,
			getApiKey: opts.getApiKey ?? (() => "test-key"),
			sessionStore,
			filesystem,
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.scriptExecutor ? { scriptExecutor: opts.scriptExecutor } : {}),
		}),
		() => ({
			sessionUpdate: async (params) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		}),
	);
	return { clientConn, updates, filesystem, sessionStore };
}
