import { test as base, expect } from "@playwright/test";
import { launchExtensionContext } from "./helpers/chrome-ext.ts";
import { ChatPanelPage } from "./pages/ChatPanel.ts";
import { EventsPanelPage } from "./pages/EventsPanel.ts";
import { SetupFormPage } from "./pages/SetupForm.ts";
import { WirePanelPage } from "./pages/WirePanel.ts";

interface Fixtures {
	setup: SetupFormPage;
	chat: ChatPanelPage;
	wire: WirePanelPage;
	events: EventsPanelPage;
	uniqueUserId: string;
	gotoStart: () => Promise<void>;
	configJson: string;
}

export const test = base.extend<Fixtures>({
	context: async ({ browser }, use, testInfo) => {
		if (testInfo.project.metadata?.chromeExt === true) {
			const ctx = await launchExtensionContext();
			await use(ctx);
			await ctx.close();
			return;
		}
		const ctx = await browser.newContext();
		await use(ctx);
		await ctx.close();
	},
	page: async ({ context }, use) => {
		const page = await context.newPage();
		await use(page);
		await page.close();
	},
	setup: async ({ page }, use) => {
		await use(new SetupFormPage(page));
	},
	chat: async ({ page }, use) => {
		await use(new ChatPanelPage(page));
	},
	wire: async ({ page }, use) => {
		await use(new WirePanelPage(page));
	},
	events: async ({ page }, use) => {
		await use(new EventsPanelPage(page));
	},
	uniqueUserId: async ({ page: _page }, use) => {
		await use(String(Date.now() + Math.floor(Math.random() * 1000)));
	},
	gotoStart: async ({ page }, use, testInfo) => {
		const transportPath =
			typeof testInfo.project.metadata?.transportPath === "string" ? testInfo.project.metadata.transportPath : "/";
		await use(async () => {
			await page.goto(transportPath);
		});
	},
	configJson: async ({ page: _page }, use, testInfo) => {
		const inProcess = testInfo.project.metadata?.inProcessAgent === true;
		if (!inProcess) {
			await use("");
			return;
		}
		const config = {
			defaultModelId: "gpt-4o-mini",
			apiKeys: {
				openai: process.env.OPENAI_API_KEY ?? "",
				anthropic: process.env.ANTHROPIC_API_KEY ?? "",
			},
		};
		await use(JSON.stringify(config));
	},
});

export { expect };
