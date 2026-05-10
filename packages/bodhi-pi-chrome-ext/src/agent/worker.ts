/// <reference lib="webworker" />
// Production builds don't reliably inject globals via vite-plugin-node-polyfills
// for worker bundles. Buffer is referenced transitively (zenfs, etc.) — polyfill
// it explicitly here before the agent module loads.
import { Buffer } from "buffer";

(globalThis as { Buffer?: unknown }).Buffer = (globalThis as { Buffer?: unknown }).Buffer ?? Buffer;

// Subpath import: the flat barrel transitively imports React UI modules whose
// Vite dev injection (@react-refresh) references `window`, which doesn't exist
// in a Worker realm. The `/worker-entry` subpath is React-free.
import { bootstrapAgentWorker } from "@bodhiapp/bodhi-pi-browser/worker-entry";

bootstrapAgentWorker({ dbName: "bodhi-pi-chrome-ext" });
