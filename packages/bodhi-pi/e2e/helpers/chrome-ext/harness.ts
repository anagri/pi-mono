import { createPageDrivenHarness } from "../browser/page-driven-harness.js";
import type { E2EHarness, E2EHarnessOptions } from "../harness.js";
import { launchChromeExtHarnessPage } from "./launch.js";

export async function createChromeExtHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	return createPageDrivenHarness(opts, {
		baseUrlEnvVar: "BODHI_PI_E2E_CHROME_EXT_BASE_URL",
		label: "e2e chrome-ext harness",
		ensurePage: launchChromeExtHarnessPage,
	});
}
