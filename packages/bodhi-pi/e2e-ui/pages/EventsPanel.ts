import type { Locator, Page } from "@playwright/test";

export class EventsPanelPage {
	readonly root: Locator;

	constructor(page: Page) {
		this.root = page.locator('[data-testid="events-panel"]');
	}

	rows(filter: { type?: string } = {}): Locator {
		let sel = '[data-testid="event"]';
		if (filter.type) sel += `[data-event-type="${filter.type}"]`;
		return this.root.locator(sel);
	}
}
