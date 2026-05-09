import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export class AppPage {
	readonly status: Locator;

	constructor(public readonly page: Page) {
		this.status = page.getByTestId("status");
	}

	async goto() {
		await this.page.goto("/");
	}

	async setSettings(opts: { email: string; id: number; sendToken: boolean }) {
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
}
