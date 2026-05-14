import type { E2EHarness } from "./harness.js";

/**
 * Best-effort `auth/<provider>` cleanup for tests that override a provider
 * during the run. http's test-app-http shares one on-disk KV across every
 * per-user session, so a leaked override breaks the next test that expects
 * pi-ai's default endpoint. Swallows errors when the connection is already
 * torn down.
 */
export async function cleanupAuthOverride(harness: E2EHarness, provider: string): Promise<void> {
	try {
		await harness.client.kv.remove({ key: `auth/${provider}` });
	} catch {
		// connection may already be torn down — ignore.
	}
}
