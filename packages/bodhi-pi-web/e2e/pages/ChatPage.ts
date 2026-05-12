import { expect, type Locator, type Page } from "@playwright/test";

export type TestState = "echo" | "initializing" | "idle" | "streaming" | "closed" | "error";
export type MessageRole = "user" | "assistant" | "system";

/** Page Object Model for the bodhi-pi-web chat surface. */
export class ChatPage {
	readonly page: Page;
	readonly chatPage: Locator;
	readonly statusBar: Locator;
	readonly messageList: Locator;
	readonly composer: Locator;
	readonly input: Locator;
	readonly sendButton: Locator;

	constructor(page: Page) {
		this.page = page;
		this.chatPage = page.getByTestId("chat-page");
		this.statusBar = page.getByTestId("status-bar");
		this.messageList = page.getByTestId("message-list");
		this.composer = page.getByTestId("composer");
		this.input = page.getByTestId("composer-input");
		this.sendButton = page.getByTestId("composer-send");
	}

	async goto() {
		await this.page.goto("/");
	}

	async waitForState(state: TestState, timeout?: number) {
		const opts = timeout !== undefined ? { timeout } : undefined;
		await expect(this.chatPage).toHaveAttribute("data-test-state", state, opts);
	}

	messages(role: MessageRole) {
		return this.page.locator(`[data-testid="message"][data-message-role="${role}"]`);
	}

	async lastMessage(role: MessageRole): Promise<string> {
		const all = await this.messages(role).all();
		const last = all.at(-1);
		if (!last) return "";
		return (await last.locator(".message-content").textContent()) ?? "";
	}

	toolCalls(filter?: { name?: string; status?: "running" | "completed" | "failed" }) {
		const parts = ['[data-testid="tool-call"]'];
		if (filter?.name) parts.push(`[data-tool-name="${filter.name}"]`);
		if (filter?.status) parts.push(`[data-tool-status="${filter.status}"]`);
		return this.page.locator(parts.join(""));
	}

	lastToolCall(name?: string) {
		return name ? this.toolCalls({ name }).last() : this.toolCalls().last();
	}

	async send(text: string) {
		await this.input.fill(text);
		await this.sendButton.click();
	}

	systemMessages() {
		return this.page.locator('[data-testid="message"][data-message-role="system"]');
	}

	async login(provider: string, apiKey: string) {
		const before = await this.systemMessages().count();
		await this.send(`/login ${provider} ${apiKey}`);
		await expect(this.systemMessages()).toHaveCount(before + 1);
		await expect(this.systemMessages().nth(before)).toContainText(`stored auth for ${provider}`);
	}

	async model(modelId: string) {
		await this.send(`/model ${modelId}`);
		await expect(this.statusBar).toHaveAttribute("data-current-model", modelId);
		await expect(this.messages("system").last()).toContainText(`model switched to: ${modelId}`);
	}

	async setup(provider: string, apiKey: string, modelId: string) {
		await this.goto();
		await this.waitForState("idle");
		await this.login(provider, apiKey);
		await this.model(modelId);
	}
}
