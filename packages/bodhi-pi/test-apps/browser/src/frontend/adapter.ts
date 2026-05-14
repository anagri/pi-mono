import { createTransportAdapter } from "../ui-lib/runtime/adapter.ts";
import type { TransportAdapter } from "../ui-lib/ui/index.ts";

export function createBrowserAdapter(): TransportAdapter {
	return createTransportAdapter({
		workerFactory: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
	});
}
