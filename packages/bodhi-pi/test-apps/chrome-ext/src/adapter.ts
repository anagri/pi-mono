import { createTransportAdapter } from "@bodhiapp/bodhi-pi-test-app-browser/runtime/adapter";
import type { TransportAdapter } from "@bodhiapp/bodhi-pi-test-app-browser/ui";
import { createSandboxPort } from "./agent/sandbox";

export function createChromeExtAdapter(): TransportAdapter {
	return createTransportAdapter({
		workerFactory: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
		createSandboxPort,
	});
}
