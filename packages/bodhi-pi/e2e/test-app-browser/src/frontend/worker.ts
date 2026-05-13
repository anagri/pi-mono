// Web Worker entry. Hosts the bodhi-pi agent via the ported browser adapters
// under `e2e/helpers/browser-adapters/`. The main thread mounts ZenFS, then
// posts an init message carrying { agentPort, cwd, dbName, models, ... };
// `bootstrapAgentWorker` boots the agent against the in-page InMemory ZenFS,
// Dexie session/kv stores, and the AsyncFunction-based script executor.

import { bootstrapAgentWorker } from "@e2e/helpers/browser-adapters/runtime/bootstrap-worker";

bootstrapAgentWorker();
