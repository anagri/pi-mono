import { test as baseTest, expect } from "@playwright/test";
import { AppPage } from "./pages/AppPage";

interface AppFixtures {
	app: AppPage;
}

export const test = baseTest.extend<AppFixtures>({
	app: async ({ page }, use) => {
		page.on("pageerror", (err) => {
			console.log(`[browser pageerror] ${err.message}\n${err.stack ?? ""}`);
		});
		await use(new AppPage(page));
	},
});

export { expect };
