import { test as baseTest, expect } from "@playwright/test";
import { ChatPage } from "./pages/ChatPage";

interface AppFixtures {
	chat: ChatPage;
}

export const test = baseTest.extend<AppFixtures>({
	chat: async ({ page }, use) => {
		// Surface browser/worker errors so e2e failures point at root cause
		// instead of generic UI timeouts.
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
