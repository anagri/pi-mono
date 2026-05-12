import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export type ChatTestState =
	| "idle"
	| "connecting"
	| "connected"
	| "disconnected"
	| "unauthorized"
	| "streaming"
	| "closed"
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

export class AppPage {
	readonly chatPage: Locator;
	readonly status: Locator;
	readonly composer: Locator;
	readonly sendButton: Locator;
	readonly eventsPanel: Locator;

	constructor(
		public readonly page: Page,
		/** WS URL the test fixture spawned for this test. Auto-filled in goto(). */
		public readonly serverUrl: string,
		/** Default identity for setSettings() when callers omit email/id. */
		public readonly tenant: { id: number; email: string },
	) {
		this.chatPage = page.getByTestId("chat-page");
		this.status = page.getByTestId("status");
		this.composer = page.getByTestId("composer");
		this.sendButton = page.getByTestId("send");
		this.eventsPanel = page.getByTestId("events-panel");
	}

	async goto() {
		await this.page.goto("/");
		// Auto-fill the Server URL slot with the fixture-bound test server URL.
		const urlField = this.page.getByTestId("settings-serverUrl");
		await urlField.fill(this.serverUrl);
	}

	async setSettings(opts?: { email?: string; id?: number; sendToken?: boolean; serverUrl?: string }) {
		const o = opts ?? {};
		if (o.serverUrl !== undefined) {
			await this.page.getByTestId("settings-serverUrl").fill(o.serverUrl);
		}
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

	async expectStatus(status: "idle" | "connecting" | "connected" | "disconnected" | "unauthorized") {
		await expect(this.status).toHaveAttribute("data-status", status);
	}

	async connect(opts?: { email?: string; id?: number; sendToken?: boolean; serverUrl?: string }) {
		await this.goto();
		await this.setSettings(opts);
		await this.clickConnect();
		await this.expectStatus("connected");
	}

	async model(modelId: string) {
		await this.send(`/model ${modelId}`);
		await expect(
			this.page.getByTestId("system-message").filter({ hasText: "model switched to" }).last(),
		).toBeVisible();
		await expect(this.status).toHaveAttribute("data-current-model", modelId);
	}

	async newSession() {
		await this.send("/new");
		await expect(this.page.getByTestId("system-message").filter({ hasText: "new session" }).last()).toBeVisible();
	}

	async setup(modelId: string, opts?: { email?: string; id?: number; sendToken?: boolean; serverUrl?: string }) {
		await this.connect(opts);
		await this.newSession();
		await this.model(modelId);
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

	async expectChatState(state: ChatTestState) {
		await expect(this.chatPage).toHaveAttribute("data-test-state", state);
	}

	async lastMessageText(role: "user" | "assistant"): Promise<string> {
		const all = this.page.locator(`[data-testid="message"][data-role="${role}"]`);
		await all.last().waitFor();
		const raw = (await all.last().innerText()).trim();
		// Strip the leading "<role>: " label rendered by App.tsx.
		const prefix = `${role}:`;
		return raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
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

	sessionRow(sessionIdPrefix: string) {
		return this.page.locator(`[data-testid="session-row"][data-session-id^="${sessionIdPrefix}"]`);
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
