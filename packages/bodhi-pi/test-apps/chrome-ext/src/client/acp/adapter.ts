import { createTransportAdapter } from "@bodhiapp/bodhi-pi-test-app-browser/client/runtime/adapter";
import type { TransportAdapter } from "@bodhiapp/bodhi-pi-test-app-utils/transport-types";
import { createSandboxPort } from "./sandbox-port.ts";

export function createChromeExtAdapter(): TransportAdapter {
	return createTransportAdapter({
		workerFactory: () =>
			new Worker(new URL("../../host/worker.ts", import.meta.url), { type: "module" }),
		createSandboxPort,
	});
}
