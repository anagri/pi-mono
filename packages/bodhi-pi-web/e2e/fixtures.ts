import { test as baseTest, expect } from "@playwright/test";
import { ChatPage } from "./pages/ChatPage";

interface AppFixtures {
	chat: ChatPage;
}

export const test = baseTest.extend<AppFixtures>({
	chat: async ({ page }, use) => {
		const chat = new ChatPage(page);
		await use(chat);
	},
});

export { expect };
