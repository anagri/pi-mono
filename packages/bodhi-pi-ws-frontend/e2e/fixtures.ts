import { test as baseTest, expect } from "@playwright/test";
import { spawnTestServer, type TestServerHandle } from "./helpers/spawn-server";
import { AppPage } from "./pages/AppPage";

interface AppFixtures {
	/** Per-test scenario directory under `e2e/data/<scenario>/`. Override via `test.use({ scenario: "name" })`. */
	scenario: string | undefined;
	/** Spawned ws-server child process bound to the resolved scenario. */
	testServer: TestServerHandle;
	app: AppPage;
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

	app: async ({ page, testServer }, use) => {
		page.on("pageerror", (err) => {
			console.log(`[browser pageerror] ${err.message}\n${err.stack ?? ""}`);
		});
		const app = new AppPage(page, testServer.url);
		await use(app);
	},
});

export { expect };
