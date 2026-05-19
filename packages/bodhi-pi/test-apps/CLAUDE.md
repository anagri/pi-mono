# bodhi-pi test-apps — runtime split

## These are TEST-APPS, not production apps

`packages/bodhi-pi/test-apps/*` exist to prove that bodhi-pi works across
its target runtime matrix (Node CLI, HTTP+SSE server, browser worker,
chrome-ext sandbox). They are NOT production apps. Their job is to be
**driveable** by automated tests — Vitest in-process / spawned-subprocess
for `e2e/`, Playwright for `e2e-ui/`. Any UI surface inside `test-apps/*`
exists so a Playwright spec can poke it, not because end-users need it.

Concrete implication for new features that have a user-interaction step
(approval prompts, multi-step wizards, confirmation flows):

- **Don't build a UI element just to satisfy the feature.** Build the
  feature against direct ACP messages — `requestPermission` is one such
  ACP method; the Client side of the round-trip can be implemented in
  the test-app's Client by accepting an in-memory queue of responses
  rather than rendering a modal.
- **e2e tests drive via direct ACP responses.** The test-app Client's
  `requestPermission` handler reads from a per-test response queue (or
  echoes a fixed verdict). Tests assert via the round-trip events
  (`tool_approval_request` / `tool_approval_response` on
  `LIFECYCLE_EVENT_METHOD`) — never by clicking a button.
- **e2e-ui (Playwright) tests drive via slash commands or composer-input
  typed responses.** Where a UI step is unavoidable (e.g. user types
  "/approve once" into the chat composer to release a pending approval),
  prefer typed text + a Playwright `chat.send(...)` over a dedicated
  modal. The slash router or composer interceptor decodes it back into
  the ACP `requestPermission` response shape.
- **One channel; two drivers.** A single Client-side `requestPermission`
  handler covers both Vitest e2e (programmatic queue) and Playwright
  (composer-typed slash). The test-app stays minimal; tests stay
  parallel-safe; no production-app UI grows in the wrong place.

If a feature actually wants a polished UI surface, that surface belongs
in a downstream consumer of `@bodhiapp/bodhi-pi` (a real Host app), not
under `test-apps/`.

## Runtime split

Five sibling packages live here. They split into two import lanes by the
runtimes they have to load in:

| Package | Lane | Runtime(s) | `node:*` / Node globals allowed? |
|---|---|---|---|
| `app-utils/` | **runtime-neutral** | cli + http(server+client) + browser + chrome-ext | **NO** |
| `browser/` | **runtime-neutral** | browser main thread + Web Worker | **NO** |
| `chrome-ext/` | **runtime-neutral** | MV3 page + sandbox iframe + Worker | **NO** |
| `http/src/client/` | **runtime-neutral** | browser (Vite-bundled React shell) | **NO** |
| `cli/` | Node-only | Node CLI process | **YES** |
| `http/src/host/` | Node-only | Node HTTP/WS server process | **YES** |
| `node-adapters/` | Node-only (shared infra) | imported by cli + http server | **YES** |

The neutrality rule is identical in spirit to the one on `bodhi-pi/src/`
(see `packages/bodhi-pi/CLAUDE.md` "Source code rules") and exists for the
same reason: any `import … from "node:*"` in a runtime-neutral file gets
externalised by Vite into a getter-stub that throws on first property read,
breaking page load before any agent code runs. The same goes for Node
globals (`Buffer`, `process`, `__dirname`) — they only "work" in browser
bundles when `vite-plugin-node-polyfills` injects them, which we refuse to
ship because it hides exactly this class of regression.

## Where to put new code

Decide by who imports it:

- **Browser/Worker/MV3 consumes it (directly or via `app-utils/`)?**
  → put it in a runtime-neutral package. Use `pathe` for path manipulation,
  `globalThis.crypto.randomUUID()` for UUIDs, `TextEncoder`/`TextDecoder`
  for byte work, `atob`/`btoa` for base64. **No** `node:*` imports.
- **Only cli + http server consume it?**
  → put it in `node-adapters/` (preferred for adapters/integrations) or in
  the consuming Host's own `src/host/`. `node:*` imports are fine; this
  code never reaches a browser bundle.
- **Both cli/http AND browser/chrome-ext consume it?**
  → split it: the runtime-neutral surface goes in `app-utils/`; the Node
  implementation goes in `node-adapters/`. The browser/MV3 Hosts supply
  their own browser-shaped implementation under their own `src/host/`.

## Why we don't ship Node polyfills

`vite-plugin-node-polyfills` (the obvious "fix" when a `node:*` import sneaks
into a browser bundle) makes the failure mode silent: it papers over the
import, the test app keeps loading, and the actual violation goes
undiscovered until the next person tries to remove the polyfill. We've been
bitten by exactly this — a one-line `import path from "node:path"` in
`app-utils/just-bash-fs-adapter.ts` survived two refactors hidden behind the
plugin, then deterministically broke `e2e/shared/bash.e2e.ts > shared-fs
round-trip` (browser + chrome-ext) when the plugin was finally dropped.

So: keep the polyfill plugin out. When a `node:*` import appears in a
runtime-neutral file, fix the import (use a runtime-neutral package like
`pathe`) — don't paper it over.

## Verification

The trunk-level `npm run check:browser-smoke` script (see
`scripts/check-browser-smoke.mjs`) is the guard. If you add a new
runtime-neutral surface (or move code between lanes), update that script
so the smoke check covers it.

For ad-hoc verification while editing:

```sh
# Any node:* import in a runtime-neutral surface = regression.
rg "from \"node:" \
  packages/bodhi-pi/src \
  packages/bodhi-pi/test-apps/app-utils \
  packages/bodhi-pi/test-apps/browser/src \
  packages/bodhi-pi/test-apps/chrome-ext/src \
  packages/bodhi-pi/test-apps/http/src/client
# expected: no matches
```

The browser/chrome-ext `vite.config.ts` files MUST NOT depend on
`vite-plugin-node-polyfills` or alias `node:crypto`/`node:path`/etc. to a
local shim — if you find yourself wanting to add either, the right fix is
in the source file, not the Vite config.
