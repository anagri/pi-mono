/* eslint-disable react-hooks/rules-of-hooks */
import { test as baseTest, expect } from "@playwright/test";
import { getExtensionId, launchExtensionContext } from "./helpers/extension";
import { DEFAULT_SEED, seedWorkspace, type WorkspaceSeed } from "./helpers/seed";
import { ChatPage } from "./pages/ChatPage";
import { EventsPanel } from "./pages/EventsPanel";

interface AppFixtures {
	chat: ChatPage;
	events: EventsPanel;
	extensionId: string;
	/** Override the default seed for a single test by setting `test.use({ workspaceSeed })`. */
	workspaceSeed: WorkspaceSeed;
}

export const test = baseTest.extend<AppFixtures>({
	workspaceSeed: [DEFAULT_SEED, { option: true }],

	// Override the default `context` and `page` fixtures with a persistent
	// chromium context that loads the bodhi-pi-chrome-ext build from dist/.
	// biome-ignore lint/correctness/noEmptyPattern: Playwright fixture with no upstream deps
	context: async ({}, use) => {
		const ctx = await launchExtensionContext();
		await use(ctx);
		await ctx.close();
	},

	page: async ({ context }, use) => {
		const page = await context.newPage();
		await use(page);
		await page.close();
	},

	// biome-ignore lint/correctness/noEmptyPattern: Playwright fixture with no upstream deps
	extensionId: async ({}, use) => {
		await use(getExtensionId());
	},

	chat: async ({ page, workspaceSeed }, use) => {
		await seedWorkspace(page, workspaceSeed);

		page.on("console", (msg) => {
			if (msg.type() === "error" || msg.type() === "warning") {
				console.log(`[browser ${msg.type()}] ${msg.text()}`);
			}
		});
		page.on("pageerror", (err) => {
			console.log(`[browser pageerror] ${err.message}\n${err.stack ?? ""}`);
		});

		const chat = new ChatPage(page);
		await use(chat);
	},

	events: async ({ page }, use) => {
		await use(new EventsPanel(page));
	},
});

export { expect };
export type { WorkspaceSeed };
