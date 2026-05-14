import { afterEach } from "vitest";
import { cleanupAuthOverride } from "./auth-cleanup.js";
import type { E2EHarness } from "./harness.js";

// Replaces the `let activeHarness ... afterEach(() => h.cleanup())` block that
// was duplicated at the top of every shared spec. Usage:
//
//   const getHarness = useHarness();
//   test("...", async () => {
//     const h = await createE2EHarness({ ... });
//     // activeHarness ref captured automatically; afterEach calls h.cleanup().
//     ...
//   });
//
// When the test overrides a provider via `auth/<provider>`, pass
// `cleanupAuthProviders: ["openai"]` so the helper removes the override before
// cleanup. http's test-app-http shares one on-disk KV across every per-user
// session — a leaked override breaks the next test that expects pi-ai's
// default endpoint.

export interface UseHarnessOptions {
	cleanupAuthProviders?: readonly string[];
}

export function useHarness(opts: UseHarnessOptions = {}): {
	active: () => E2EHarness | undefined;
	set: (h: E2EHarness) => E2EHarness;
} {
	let active: E2EHarness | undefined;

	afterEach(async () => {
		if (!active) return;
		const harness = active;
		active = undefined;
		if (opts.cleanupAuthProviders) {
			for (const provider of opts.cleanupAuthProviders) {
				await cleanupAuthOverride(harness, provider);
			}
		}
		await harness.cleanup();
	});

	return {
		active: () => active,
		set: (h: E2EHarness) => {
			active = h;
			return h;
		},
	};
}
