import { WIRE_ROW_ATTRS } from "@bodhiapp/bodhi-pi";
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
		if (filter.direction) sel += `[${WIRE_ROW_ATTRS.direction}="${filter.direction}"]`;
		if (filter.kind) sel += `[${WIRE_ROW_ATTRS.kind}="${filter.kind}"]`;
		if (filter.method) sel += `[${WIRE_ROW_ATTRS.method}="${filter.method}"]`;
		if (filter.rpcId) sel += `[${WIRE_ROW_ATTRS.rpcId}="${filter.rpcId}"]`;
		return this.root.locator(sel);
	}
}
