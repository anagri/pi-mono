import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export class AppPage {
	readonly status: Locator;
	readonly composer: Locator;
	readonly sendButton: Locator;

	constructor(
		public readonly page: Page,
		/** WS URL the test fixture spawned for this test. Auto-filled in goto(). */
		public readonly serverUrl: string,
	) {
		this.status = page.getByTestId("status");
		this.composer = page.getByTestId("composer");
		this.sendButton = page.getByTestId("send");
	}

	async goto() {
		await this.page.goto("/");
		// Auto-fill the Server URL slot with the fixture-bound test server URL.
		const urlField = this.page.getByTestId("settings-serverUrl");
		await urlField.fill(this.serverUrl);
	}

	async setSettings(opts: { email: string; id: number; sendToken: boolean; serverUrl?: string }) {
		if (opts.serverUrl !== undefined) {
			await this.page.getByTestId("settings-serverUrl").fill(opts.serverUrl);
		}
		await this.page.getByTestId("settings-email").fill(opts.email);
		const idField = this.page.getByTestId("settings-id");
		await idField.fill("");
		await idField.fill(String(opts.id));
		const checkbox = this.page.getByTestId("settings-sendToken");
		if ((await checkbox.isChecked()) !== opts.sendToken) {
			await checkbox.click();
		}
	}

	async clickConnect() {
		await this.page.getByTestId("connect").click();
	}

	async expectStatus(status: "idle" | "connecting" | "connected" | "disconnected" | "unauthorized") {
		await expect(this.status).toHaveAttribute("data-status", status);
	}

	async expectAgentName(name: string) {
		await expect(this.status).toHaveAttribute("data-agent-name", name);
	}

	async send(text: string) {
		await this.composer.fill(text);
		await this.sendButton.click();
	}

	async expectChatStatus(status: "idle" | "streaming") {
		await expect(this.status).toHaveAttribute("data-chat-status", status);
	}

	async lastMessageText(role: "user" | "assistant"): Promise<string> {
		const all = this.page.locator(`[data-testid="message"][data-role="${role}"]`);
		await all.last().waitFor();
		return (await all.last().innerText()).trim();
	}

	toolCalls(filter?: { name?: string; status?: string }) {
		let sel = '[data-testid="tool-call"]';
		if (filter?.name) sel += `[data-tool-name="${filter.name}"]`;
		if (filter?.status) sel += `[data-tool-status="${filter.status}"]`;
		return this.page.locator(sel);
	}

	sessionRows() {
		return this.page.locator('[data-testid="session-row"]');
	}

	async clickNewSession() {
		await this.page.getByTestId("new-session").click();
	}

	sessionRow(sessionIdPrefix: string) {
		return this.page.locator(`[data-testid="session-row"][data-session-id^="${sessionIdPrefix}"]`);
	}
}
