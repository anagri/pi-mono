import { test as baseTest, expect, type TestInfo } from "@playwright/test";
import { spawnTestServer, type TestServerHandle } from "./helpers/spawn-server.js";
import { AppPage } from "./pages/AppPage.js";

export interface Tenant {
	id: number;
	email: string;
}

interface AppFixtures {
	scenario: string | string[] | undefined;
	testServer: TestServerHandle;
	tenant: Tenant;
	app: AppPage;
}

/**
 * Stable per-test (id, email) so failure logs are easy to attribute, even
 * though per-test servers already isolate via SQLite. Mirrors ws-frontend's
 * FNV-1a hash from `e2e/fixtures.ts:20-29`.
 */
function deriveTenant(testInfo: TestInfo): Tenant {
	const key = testInfo.titlePath.join("/");
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	const id = 1_000_000 + ((h >>> 0) % 1_000_000_000);
	return { id, email: `e2e-${id}@bodhi-pi.test` };
}

export const test = baseTest.extend<AppFixtures>({
	scenario: [undefined, { option: true }],

	testServer: async ({ scenario }, use) => {
		const handle = await spawnTestServer(scenario ? { scenario } : {});
		try {
			await use(handle);
		} finally {
			await handle.cleanup();
		}
	},

	// biome-ignore lint/correctness/noEmptyPattern: Playwright fixture deps go in the first param; this fixture has none.
	tenant: async ({}, use, testInfo) => {
		await use(deriveTenant(testInfo));
	},

	app: async ({ page, testServer, tenant }, use) => {
		page.on("pageerror", (err) => {
			console.log(`[browser pageerror] ${err.message}\n${err.stack ?? ""}`);
		});
		const app = new AppPage(page, testServer.url, tenant);
		await use(app);
	},
});

export { expect };
