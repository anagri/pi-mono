// Web Worker entry. Hosts the bodhi-pi agent via the shared browser ui-lib
// from `@bodhiapp/bodhi-pi-test-app-browser`. Init message carries the
// seedFiles + adapter config + sandboxPort; `bootstrapAgentWorker` mounts an
// InMemory ZenFS at `cwd`, swaps in the sandboxed script-executor /
// extension-loader variants (MV3 forbids unsafe-eval in the worker realm),
// then wires Dexie session/kv stores.
//
// `Buffer` is set on globalThis here because vite-plugin-node-polyfills's
// `globals: { Buffer: true }` injection doesn't reach worker bundles under
// Vite 8/rolldown's production output. bodhi-pi tools (read/write/run-script)
// rely on `Buffer.byteLength` for size accounting.

import { bootstrapAgentWorker } from "@bodhiapp/bodhi-pi-test-app-browser/host/runtime/bootstrap-worker";
import { Buffer as BufferPolyfill } from "buffer";

(globalThis as { Buffer?: typeof BufferPolyfill }).Buffer = BufferPolyfill;

bootstrapAgentWorker();
