import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import { AUTH_PREFIX, EXT_KV_SET, MODEL_CONFIG_ID } from "@/index.js";

export interface SeedAuthOptions {
	clientConn: ClientSideConnection;
	sessionId: string;
	provider: string;
	apiKey: string;
	/** Model id to switch the session's current model to. */
	modelId: string;
}

/**
 * Blackbox 2-step setup for a real-LLM e2e:
 *   1. `/login <provider> <api-key>`  →  `_bodhi-pi/kv/set` with `sessionId` —
 *      writes the kvStore entry AND returns fresh `configOptions`.
 *   2. `/model <id>` → `setSessionConfigOption("model", <id>)` — switches the
 *      session's current model.
 *
 * Both steps return `configOptions` so hosts auto-refresh their picker; tests
 * don't need to poll `_bodhi-pi/session/config`. Drop a separate
 * `_bodhi-pi/session/settings/set defaultModel ...` call unless the test
 * specifically wants to persist the default for FUTURE sessions on this cwd.
 */
export async function seedAuth(opts: SeedAuthOptions): Promise<void> {
	await opts.clientConn.extMethod(EXT_KV_SET, {
		sessionId: opts.sessionId,
		key: `${AUTH_PREFIX}${opts.provider}`,
		value: opts.apiKey,
		secret: true,
	});
	await opts.clientConn.setSessionConfigOption({
		sessionId: opts.sessionId,
		configId: MODEL_CONFIG_ID,
		value: opts.modelId,
	});
}
