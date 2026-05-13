import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export type ChatTestState =
	| "idle"
	| "connecting"
	| "connected"
	| "disconnected"
	| "unauthorized"
	| "streaming"
	| "error";

export interface LifecycleFilter {
	type?: string;
	toolName?: string;
}

export interface WireFilter {
	method?: string;
	direction?: "in" | "out";
	kind?: "request" | "response" | "notification" | "error" | "unknown";
	rpcId?: string;
}

/**
 * Page Object for the bodhi-pi-http UI. Mirrors `bodhi-pi-ws-frontend/e2e/pages/AppPage.ts`
 * but drops the `serverUrl` field — bodhi-pi-http is same-origin (the same process serves
 * both `/acp` and the static frontend), so each test navigates to its spawned server's URL
 * directly.
 */
export class AppPage {
	readonly chatPage: Locator;
	readonly status: Locator;
	readonly composer: Locator;
	readonly sendButton: Locator;
	readonly stopButton: Locator;
	readonly eventsPanel: Locator;

	constructor(
		public readonly page: Page,
		/** Base URL of the bodhi-pi-http process spawned for this test. */
		public readonly serverUrl: string,
		/** Default identity for setSettings() when callers omit email/id. */
		public readonly tenant: { id: number; email: string },
	) {
		this.chatPage = page.getByTestId("chat-page");
		this.status = page.getByTestId("status");
		this.composer = page.getByTestId("composer");
		this.sendButton = page.getByTestId("send");
		this.stopButton = page.getByTestId("composer-stop");
		this.eventsPanel = page.getByTestId("events-panel");
	}

	async goto() {
		await this.page.goto(this.serverUrl);
	}

	async setSettings(opts?: { email?: string; id?: number; sendToken?: boolean }) {
		const o = opts ?? {};
		await this.page.getByTestId("settings-email").fill(o.email ?? this.tenant.email);
		const idField = this.page.getByTestId("settings-id");
		await idField.fill("");
		await idField.fill(String(o.id ?? this.tenant.id));
		const sendToken = o.sendToken ?? true;
		const checkbox = this.page.getByTestId("settings-sendToken");
		if ((await checkbox.isChecked()) !== sendToken) {
			await checkbox.click();
		}
	}

	async clickConnect() {
		await this.page.getByTestId("connect").click();
	}

	async clickDisconnect() {
		await this.page.getByTestId("disconnect").click();
	}

	async connect(opts?: { email?: string; id?: number; sendToken?: boolean }) {
		await this.goto();
		await this.setSettings(opts);
		await this.clickConnect();
		await this.expectStatus("connected");
		await expect(this.status).not.toHaveAttribute("data-session-id", "");
	}

	async model(modelId: string) {
		await this.send(`/model ${modelId}`);
		await expect(this.systemMessages().filter({ hasText: "model switched to" }).last()).toBeVisible();
		await expect(this.status).toHaveAttribute("data-current-model", modelId);
	}

	async setup(modelId: string, opts?: { email?: string; id?: number; sendToken?: boolean }) {
		await this.connect(opts);
		await this.model(modelId);
	}

	async expectStatus(status: "idle" | "connecting" | "connected" | "disconnected" | "unauthorized" | "error") {
		await expect(this.status).toHaveAttribute("data-status", status);
	}

	async send(text: string) {
		await this.composer.fill(text);
		await this.sendButton.click();
	}

	async login(provider: string, apiKey: string) {
		const before = await this.systemMessages().count();
		await this.send(`/login ${provider} api_key="${apiKey}"`);
		await expect(this.systemMessages()).toHaveCount(before + 1);
		await expect(this.systemMessages().nth(before)).toContainText(`stored auth for ${provider}`);
	}

	async expectChatStatus(status: "idle" | "streaming" | "error") {
		await expect(this.status).toHaveAttribute("data-chat-status", status);
	}

	async expectChatState(state: ChatTestState) {
		await expect(this.chatPage).toHaveAttribute("data-test-state", state);
	}

	async lastMessageText(role: "user" | "assistant"): Promise<string> {
		const all = this.page.locator(`[data-testid="message"][data-role="${role}"]`);
		await all.last().waitFor();
		const raw = (await all.last().innerText()).trim();
		const prefix = role === "user" ? "you:" : "agent:";
		return raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
	}

	systemMessages() {
		return this.page.locator('[data-testid="system-message"]');
	}

	async lastSystemMessage(): Promise<string> {
		const all = this.systemMessages();
		await all.last().waitFor();
		return (await all.last().innerText()).trim();
	}

	toolCalls(filter?: { name?: string; status?: string; toolCallId?: string }) {
		let sel = '[data-testid="tool-call"]';
		if (filter?.name) sel += `[data-tool-name="${filter.name}"]`;
		if (filter?.status) sel += `[data-tool-status="${filter.status}"]`;
		if (filter?.toolCallId) sel += `[data-tool-call-id="${filter.toolCallId}"]`;
		return this.page.locator(sel);
	}

	async selectEventTab(name: "lifecycle" | "wire") {
		await this.page.locator(`[data-testid="events-tab"][data-tab-name="${name}"]`).click();
	}

	lifecycleRows(filter?: LifecycleFilter): Locator {
		const parts = ['[data-testid="event-row"][data-event-source="lifecycle"]'];
		if (filter?.type) parts.push(`[data-event-type="${filter.type}"]`);
		if (filter?.toolName) parts.push(`[data-tool-name="${filter.toolName}"]`);
		return this.page.locator(parts.join(""));
	}

	wireRows(filter?: WireFilter): Locator {
		const parts = ['[data-testid="event-row"][data-event-source="wire"]'];
		if (filter?.direction) parts.push(`[data-event-direction="${filter.direction}"]`);
		if (filter?.kind) parts.push(`[data-event-kind="${filter.kind}"]`);
		if (filter?.method) parts.push(`[data-event-method="${filter.method}"]`);
		if (filter?.rpcId) parts.push(`[data-rpc-id="${filter.rpcId}"]`);
		return this.page.locator(parts.join(""));
	}
}
