import type { Locator, Page } from "@playwright/test";

export class WirePanelPage {
	readonly root: Locator;

	constructor(page: Page) {
		this.root = page.locator('[data-testid="wire-panel"]');
	}

	rows(
		filter: {
			direction?: "in" | "out";
			method?: string;
			kind?: "request" | "response" | "notification";
			rpcId?: string;
		} = {},
	): Locator {
		let sel = '[data-testid="frame"]';
		if (filter.direction) sel += `[data-frame-direction="${filter.direction}"]`;
		if (filter.kind) sel += `[data-frame-kind="${filter.kind}"]`;
		if (filter.method) sel += `[data-frame-method="${filter.method}"]`;
		if (filter.rpcId) sel += `[data-frame-rpc-id="${filter.rpcId}"]`;
		return this.root.locator(sel);
	}
}
