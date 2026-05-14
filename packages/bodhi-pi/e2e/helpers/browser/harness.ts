import type { E2EHarness, E2EHarnessOptions } from "../harness.js";
import { launchHarnessContext } from "./launch.js";
import { createPageDrivenHarness } from "./page-driven-harness.js";

export async function createBrowserHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	return createPageDrivenHarness(opts, {
		baseUrlEnvVar: "BODHI_PI_E2E_BROWSER_BASE_URL",
		label: "e2e browser harness",
		ensurePage: launchHarnessContext,
	});
}
