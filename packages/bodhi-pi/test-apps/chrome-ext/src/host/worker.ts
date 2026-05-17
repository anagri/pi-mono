// Web Worker entry. Hosts the bodhi-pi agent via the shared browser ui-lib
// from `@bodhiapp/bodhi-pi-test-app-browser`. Init message carries the
// seedFiles + adapter config + sandboxPort; `bootstrapAgentWorker` mounts an
// InMemory ZenFS at `cwd`, swaps in the sandboxed script-executor /
// extension-loader variants (MV3 forbids unsafe-eval in the worker realm),
// then wires Dexie session/kv stores.

import { bootstrapAgentWorker } from "@bodhiapp/bodhi-pi-test-app-browser/host/runtime/bootstrap-worker";

bootstrapAgentWorker();
