import { test as baseTest, expect } from "@playwright/test";
import { DEFAULT_SEED, seedWorkspace, type WorkspaceSeed } from "./helpers/seed";
import { ChatPage } from "./pages/ChatPage";

interface AppFixtures {
	chat: ChatPage;
	/** Override the default seed for a single test by setting `test.use({ workspaceSeed })`. */
	workspaceSeed: WorkspaceSeed;
}

export const test = baseTest.extend<AppFixtures>({
	workspaceSeed: [DEFAULT_SEED, { option: true }],

	chat: async ({ page, workspaceSeed }, use) => {
		// Inject workspace seed BEFORE goto so bootstrapWorkspace short-circuits
		// past Chrome's File System Access picker.
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
});

export { expect };
export type { WorkspaceSeed };
