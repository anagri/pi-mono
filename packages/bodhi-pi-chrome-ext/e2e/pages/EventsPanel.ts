import type { Locator, Page } from "@playwright/test";

export type EventsTab = "lifecycle" | "wire";

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

export class EventsPanel {
	readonly page: Page;
	readonly panel: Locator;
	readonly body: Locator;

	constructor(page: Page) {
		this.page = page;
		this.panel = page.getByTestId("events-panel");
		this.body = page.getByTestId("events-panel-body");
	}

	tab(name: EventsTab): Locator {
		return this.page.locator(`[data-testid="events-tab"][data-tab-name="${name}"]`);
	}

	async selectTab(name: EventsTab): Promise<void> {
		await this.tab(name).click();
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
