// Web Worker entry. Hosts the bodhi-pi agent via the Host-side adapters
// under `src/host/`. Init message carries the seedFiles + adapter config;
// `bootstrapAgentWorker` mounts an InMemory ZenFS at `cwd`, then wires Dexie
// session/kv stores + the AsyncFunction-based script executor.
//
// `Buffer` is set on globalThis here because vite-plugin-node-polyfills's
// `globals: { Buffer: true }` injection doesn't reach worker bundles under
// Vite 8/rolldown's production output. bodhi-pi/src/ no longer uses Buffer,
// but `just-bash` (the bash tool adapter on browser/Worker) does — without
// this injection, the bash tool round-trips silently fail (cat reports the
// file as missing even when write succeeded).

import { Buffer as BufferPolyfill } from "buffer";
import { bootstrapAgentWorker } from "./runtime/bootstrap-worker";

(globalThis as { Buffer?: typeof BufferPolyfill }).Buffer = BufferPolyfill;

bootstrapAgentWorker();
