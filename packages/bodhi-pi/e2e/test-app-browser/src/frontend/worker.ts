// Web Worker entry. Hosts the bodhi-pi agent via the ported browser adapters
// under `e2e/helpers/browser-adapters/`. Init message carries the seedFiles +
// adapter config; `bootstrapAgentWorker` mounts an InMemory ZenFS at `cwd`,
// then wires Dexie session/kv stores + the AsyncFunction-based script
// executor.
//
// `Buffer` is set on globalThis here because vite-plugin-node-polyfills's
// `globals: { Buffer: true }` injection doesn't reach worker bundles under
// Vite 8/rolldown's production output. bodhi-pi tools (read/write/run-script)
// rely on `Buffer.byteLength` for size accounting.

import { bootstrapAgentWorker } from "@e2e/helpers/browser-adapters/runtime/bootstrap-worker";
import { Buffer as BufferPolyfill } from "buffer";

(globalThis as { Buffer?: typeof BufferPolyfill }).Buffer = BufferPolyfill;

bootstrapAgentWorker();
