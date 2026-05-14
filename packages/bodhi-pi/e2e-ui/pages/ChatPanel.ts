import { expect, type Locator, type Page } from "@playwright/test";

export class ChatPanelPage {
	readonly root: Locator;
	private readonly page: Page;

	constructor(page: Page) {
		this.page = page;
		this.root = page.locator('[data-testid="chat-panel"]');
	}

	async send(text: string): Promise<void> {
		await this.page.fill('[data-testid="composer-input"]', text);
		await this.page.click('[data-testid="composer-send"][data-mode="send"]');
	}

	async stop(): Promise<void> {
		await this.page.click('[data-testid="composer-send"][data-mode="stop"]');
	}

	async waitForIdle(timeout = 60_000): Promise<void> {
		await expect(this.root).toHaveAttribute("data-test-state", "idle", { timeout });
	}

	async waitForStreaming(timeout = 30_000): Promise<void> {
		await expect(this.root).toHaveAttribute("data-test-state", "streaming", { timeout });
	}

	messages(role: "user" | "assistant" | "system"): Locator {
		return this.root.locator(`[data-testid="chat-message"][data-message-role="${role}"]`);
	}

	lastMessage(role: "user" | "assistant" | "system"): Locator {
		return this.messages(role).last();
	}

	toolCalls(filter: { name?: string; status?: "running" | "completed" | "failed" } = {}): Locator {
		let sel = '[data-testid="tool-call"]';
		if (filter.name) sel += `[data-tool-name="${filter.name}"]`;
		if (filter.status) sel += `[data-tool-status="${filter.status}"]`;
		return this.root.locator(sel);
	}

	get currentModel(): Locator {
		return this.root;
	}

	get sessionId(): Locator {
		return this.root;
	}
}
