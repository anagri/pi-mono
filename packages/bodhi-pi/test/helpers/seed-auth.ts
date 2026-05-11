import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { AUTH_PREFIX, EXT_KV_SET, EXT_SESSION_SETTINGS_SET, MODEL_CONFIG_ID } from "@/index.js";

export interface SeedAuthOptions {
	clientConn: ClientSideConnection;
	sessionId: string;
	provider: string;
	apiKey: string;
	/** Model id to mark as default (written to project settings) and to activate. */
	modelId: string;
}

/**
 * Blackbox 3-step setup for a real-LLM e2e:
 *   1. `/login <provider> <api-key>`  →  `_bodhi-pi/kv/set auth/<provider>`
 *   2. `/settings set defaultModel <id> --project`  →  project settings file
 *   3. `/model <id>`  →  `setSessionConfigOption("model", <id>)`
 *
 * All three steps go over ACP — no whitebox seam. Use in `beforeAll`/`beforeEach`
 * after `clientConn.newSession(...)` returns the session id.
 */
export async function seedAuth(opts: SeedAuthOptions): Promise<void> {
	await opts.clientConn.extMethod(EXT_KV_SET, {
		key: `${AUTH_PREFIX}${opts.provider}`,
		value: opts.apiKey,
		secret: true,
	});
	await opts.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
		sessionId: opts.sessionId,
		key: "defaultModel",
		value: opts.modelId,
		scope: "project",
	});
	await opts.clientConn.setSessionConfigOption({
		sessionId: opts.sessionId,
		configId: MODEL_CONFIG_ID,
		value: opts.modelId,
	});
}
