import type { E2EHarness } from "./harness.js";
import { withTimeout } from "./with-timeout.js";

/**
 * Best-effort `auth/<provider>` cleanup. Bounded to 5s — a hanging connection
 * shouldn't take down the whole afterEach budget. http's shared test-app-http
 * SQLite KV plus the random-userId scheme make leftover overrides usually
 * harmless across tests, but we still try to drop them.
 */
export async function cleanupAuthOverride(harness: E2EHarness, provider: string): Promise<void> {
	await withTimeout(`kv.remove(auth/${provider})`, 5_000, () => harness.client.kv.remove({ key: `auth/${provider}` }));
}
