/* eslint-disable react-hooks/rules-of-hooks */
import { test as baseTest, expect } from "@playwright/test";
import { DEFAULT_SEED, seedWorkspace, type WorkspaceSeed } from "./helpers/seed";
import { ChatPage } from "./pages/ChatPage";
import { EventsPanel } from "./pages/EventsPanel";

interface AppFixtures {
	chat: ChatPage;
	events: EventsPanel;
	/** Override the default seed for a single test by setting `test.use({ workspaceSeed })`. */
	workspaceSeed: WorkspaceSeed;
}

export const test = baseTest.extend<AppFixtures>({
	workspaceSeed: [DEFAULT_SEED, { option: true }],

	chat: async ({ page, workspaceSeed }, use) => {
		// Seed must be injected BEFORE goto so bootstrapWorkspace picks it up.
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
