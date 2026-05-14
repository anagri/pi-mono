import type { Page } from "@playwright/test";

export interface FillOptions {
	userId: string;
	email: string;
	seedXml?: string;
	configJson?: string;
}

export class SetupFormPage {
	private readonly page: Page;
	constructor(page: Page) {
		this.page = page;
	}

	async fill(opts: FillOptions): Promise<void> {
		await this.page.fill('[data-testid="user-id"]', opts.userId);
		await this.page.fill('[data-testid="user-email"]', opts.email);
		if (opts.seedXml !== undefined) await this.page.fill('[data-testid="seed-files"]', opts.seedXml);
		if (opts.configJson !== undefined) await this.page.fill('[data-testid="config"]', opts.configJson);
	}

	async submit(): Promise<void> {
		await this.page.click('[data-testid="setup-submit"]');
		await this.page.waitForSelector('[data-testid="test-app-root"][data-test-state="ready"]');
	}

	async fillAndSubmit(opts: FillOptions): Promise<void> {
		await this.fill(opts);
		await this.submit();
	}
}
