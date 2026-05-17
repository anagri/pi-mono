// Web Worker entry. Hosts the bodhi-pi agent via the Host-side adapters
// under `src/host/`. Init message carries the seedFiles + adapter config;
// `bootstrapAgentWorker` mounts an InMemory ZenFS at `cwd`, then wires Dexie
// session/kv stores + the AsyncFunction-based script executor.

import { bootstrapAgentWorker } from "./runtime/bootstrap-worker";

bootstrapAgentWorker();
