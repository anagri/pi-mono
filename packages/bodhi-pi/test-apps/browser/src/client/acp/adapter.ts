import type { TransportAdapter } from "@bodhiapp/bodhi-pi-test-app-utils/transport-types";
import { createTransportAdapter } from "../runtime/adapter.ts";

export function createBrowserAdapter(): TransportAdapter {
	return createTransportAdapter({
		workerFactory: () =>
			new Worker(new URL("../../host/worker.ts", import.meta.url), { type: "module" }),
	});
}
