# bodhi-pi-browser

**Workspace-internal PoC infrastructure** for browser hosts of `@bodhiapp/bodhi-pi`. Used by `bodhi-pi-web` and `bodhi-pi-chrome-ext`. Not published; `package.json` is `private: true`.

The shared content for browser-host PoCs (UI components, agent runtime glue, stores, workspace bootstrap, env helper) lives here so each browser host can stay thin.

All the bodhi-pi-* runtimes, including this are Proof of Concepts, so there is no production deployment of these PoCs, there is no backwards compatability requirement, no data migration requirment, makes development of bodhi-pi quicker with these PoCs checking it works in all runtimes.

## Contents

| Area | Module | Role |
|---|---|---|
| Adapters | `filesystem/`, `sessions/`, `script-executor/`, `transport/`, `extensions/` | Same as before — bodhi-pi browser-runtime adapters |
| Runtime | `runtime/bootstrap-worker.ts` | `bootstrapAgentWorker({ dbName? })` — registers the worker-side init listener; called once from each host's `worker.ts` |
| Runtime | `runtime/runtime.ts` | `startAgentRuntime(opts)` — main-thread side: takes `workerFactory: () => Worker` (host-owned spawn so Vite resolves the worker URL against host source) |
| Runtime | `runtime/{render,wire-tap,session-storage,types}.ts` | dispatchNotification, byte-level wire taps, sessionStorage helpers, InitMessage type |
| Stores | `store/{chatStore,eventStore}.ts` | Zustand stores backing `<MessageList>` and `<EventsPanel>` |
| Workspace | `workspace/{provider,bootstrap}.ts` | `WorkspaceProvider` interface, FSA + seed implementations, `bootstrapWorkspace()` flow |
| UI | `ui/*.tsx` and `ui/commands.ts` | `<RuntimeProvider>`, `<ChatPage>`, `<EventsPanel>`, `<DirectoryGate>`, etc. + slash-command dispatcher |
| Env | `env/env.ts` | `buildResolvedEnv(getEnvVar)` — host injects its env getter (e.g. `(k) => import.meta.env[k]`) so this package never reaches Vite globals |

## Package exports

- `.` — flat barrel: every adapter + runtime + UI + store + workspace + env helper. Main thread imports from here.
- `./worker-entry` — direct alias to `runtime/bootstrap-worker.js`. **Worker entries must use this subpath**, not the flat barrel. The barrel transitively imports React UI modules whose Vite-dev `@react-refresh` runtime touches `window`, which doesn't exist in a Worker realm. The subpath bypasses everything React.

## Host contract

A browser host needs only:

```ts
// host/src/agent/worker.ts
import { bootstrapAgentWorker } from "@bodhiapp/bodhi-pi-browser/worker-entry";
bootstrapAgentWorker({ dbName: "<host-specific>" });

// host/src/agent/runtime.ts
export function workerFactory(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

// host/src/env.ts
import { buildResolvedEnv } from "@bodhiapp/bodhi-pi-browser";
export const env = buildResolvedEnv((k) => (import.meta.env as Record<string, string | undefined>)[k]);

// host/src/App.tsx
import { RuntimeProvider, ChatPage, EventsPanel, DirectoryGate, bootstrapWorkspace, ... } from "@bodhiapp/bodhi-pi-browser";
import { workerFactory } from "./agent/runtime";
import { env } from "./env";
// ... <RuntimeProvider workspace={...} env={env} workerFactory={workerFactory}>
```

That's the entire host surface besides `main.tsx`, CSS, `vite.config.ts`, `index.html`, package config, and an extension manifest where applicable.

## Build + test

- `npm run build` — tsgo + tsc-alias compiles `src/**/*.ts(x)` to `dist/`. JSX uses `react-jsx`.
- `npm run test` — vitest runs adapter unit tests (`src/**/*.test.ts`) under fake-indexeddb. UI/runtime/store have no unit tests in this package — they're covered by host e2e.

## Source code rules

- **Worker-context vs main-thread separation.** `runtime/bootstrap-worker.ts` runs in worker realm and uses `self`/`DedicatedWorkerGlobalScope`. Everything else is main-thread. UI imports React; never import any UI module from worker code.
- **No `node:*` imports.** Browser-target only. `@types/node` exists in devDeps for tooling type compat (e.g. `MessagePort` lib resolution in test files).
- **No `import.meta.env` references.** Env reading is host-injected via `buildResolvedEnv(getEnvVar)`.
- **Compose, don't subclass `Dexie`** (tsgo extends-typing limitation).
- **AsyncFunction-based `ScriptExecutor` needs `unsafe-eval` CSP.** Document for production hosts.
- **`requestPermission` must run from a user gesture.** `<DirectoryGate>` calls it inside a click handler.
