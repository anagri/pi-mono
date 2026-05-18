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

	// 60s default exceeds the global 30s expect budget because waitForIdle
	// brackets a full real-LLM turn — same rationale as the 60s overrides in
	// packages/bodhi-pi/e2e/CLAUDE.md "Timeouts" section.
	async waitForIdle(timeout = 60_000): Promise<void> {
		await expect(this.root).toHaveAttribute("data-test-state", "idle", { timeout });
	}

	async waitForStreaming(): Promise<void> {
		await expect(this.root).toHaveAttribute("data-test-state", "streaming");
	}

	messages(role: "user" | "assistant" | "system"): Locator {
		return this.root.locator(`[data-testid="chat-message"][data-message-role="${role}"]`);
	}

	lastMessage(role: "user" | "assistant" | "system"): Locator {
		return this.messages(role).last();
	}

	lastDoneMessage(role: "user" | "assistant" | "system"): Locator {
		return this.root
			.locator(`[data-testid="chat-message"][data-message-role="${role}"][data-test-state="done"]`)
			.last();
	}

	toolCalls(filter: { name?: string; status?: "running" | "completed" | "failed" } = {}): Locator {
		let sel = '[data-testid="tool-call"]';
		if (filter.name) sel += `[data-tool-name="${filter.name}"]`;
		if (filter.status) sel += `[data-tool-status="${filter.status}"]`;
		return this.root.locator(sel);
	}

	async currentModel(): Promise<string> {
		return (await this.root.getAttribute("data-current-model")) ?? "";
	}

	async sessionId(): Promise<string> {
		return (await this.root.getAttribute("data-session-id")) ?? "";
	}

	systemMessages(): Locator {
		return this.messages("system");
	}

	systemMessageWithEvent(eventName: string, options: { name?: string } = {}): Locator {
		let selector = `[data-testid="chat-message"][data-message-role="system"][data-subagent-event="${eventName}"]`;
		if (options.name) selector += `[data-subagent-name="${options.name}"]`;
		return this.root.locator(selector);
	}

	lastSystemText(): Promise<string> {
		return this.systemMessages().last().innerText();
	}
}
