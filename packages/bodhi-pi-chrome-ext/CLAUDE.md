# bodhi-pi-chrome-ext

Reference Chrome extension host for `@bodhiapp/bodhi-pi`. **PoC** — proves the agent runs unchanged inside an MV3 extension. Counterpart to `bodhi-pi-web` (browser tab) and to the cli/ws/http hosts. Both browser hosts are thin consumers of `@bodhiapp/bodhi-pi-browser` (the shared workspace package that owns adapters + UI + runtime + stores).

Real apps that follow the same shape: a sidepanel + page-tools agent (Claude-in-Chrome style) and a bookmarks/history agent. They will reuse this PoC's recipe — extension page + Web Worker + shared package — and add their own tool surfaces.

## Architecture

```
chrome-extension://<id>/index.html  (React shell, identical to bodhi-pi-web)
        │ spawns (host-owned URL resolution)
        ▼
   Web Worker (bodhi-pi agent via bootstrapAgentWorker)
        │ ACP ndjson over MessagePort
        ▼
   ChatPage + EventsPanel (from @bodhiapp/bodhi-pi-browser)
```

`background.ts` is a 5-line service worker that opens `index.html` in a new tab on action click. It does **not** host the agent (MV3 service workers can't spawn Web Workers and disallow dynamic-code CSP).

## Host contract

- `src/agent/worker.ts` — 3 lines: `import { bootstrapAgentWorker } from "@bodhiapp/bodhi-pi-browser/worker-entry"; bootstrapAgentWorker({ dbName: "bodhi-pi-chrome-ext" });`. Uses the `/worker-entry` subpath to avoid the React-tainted barrel (Vite's `@react-refresh` references `window`, undefined in worker realm).
- `src/agent/runtime.ts` — 5 lines: `workerFactory` that calls `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`. Host-owned so Vite resolves the worker URL against host source.
- `src/agent/crypto-shim.ts` — vite-alias target for `node:crypto` → `globalThis.crypto.randomUUID`.
- `src/env.ts` — 5-line wrapper around shared `buildResolvedEnv` reading `import.meta.env.VITE_*`.
- `src/background.ts` — action-click → open chat tab.
- `src/main.tsx`, `src/App.tsx` — copies of bodhi-pi-web's host shell.

## Build + key

- `npm run gen-key` — once per repo. Generates `key.pem` (gitignored), patches `manifest.json#key`, writes `.ext-id` (committed). Stable extension id across reloads + e2e.
- `npm run build` — `tsc -b && vite build && node scripts/copy-manifest.mjs`. Output is loadable as an unpacked extension at `chrome://extensions`.
- The Vite config sets `base: "./"` (relative URLs work under chrome-extension://) and emits a fixed `background.js` (manifest references it by path).

## Manifest

- MV3, no permissions for the PoC.
- `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`.
  - **`'unsafe-eval'` is forbidden in MV3 extension pages.** Chrome rejects the whole manifest if it appears. This is enforced; the PoC strips it.
  - Consequence: `BrowserScriptExecutor` (AsyncFunction-based `run_script` tool) **does not work** in this host. Specs that exercise it are expected to fail. Real apps that need scripting in MV3 must move script execution into a sandboxed iframe, an offscreen document, or a different mechanism.
  - `extensions.spec.ts` also fails because `createBrowserExtensionLoader` uses `import("data:text/javascript;base64,...")`, which is also blocked under the strict CSP.

## E2e

- Playwright launches `chromium.launchPersistentContext` with `--load-extension=<dist>` and `headless: false`. Headless modes do not reliably load MV3 extensions (`ERR_BLOCKED_BY_CLIENT`); document this in CI when wiring it up.
- Specs are copied from `bodhi-pi-web/e2e/` verbatim. The only delta is `pages/ChatPage.ts:goto()` which navigates to `/index.html` (chrome-extension:// origins don't auto-resolve `/`).
- Fixture in `e2e/fixtures.ts` overrides `context` and `page` to use the persistent context.

## Source code rules

- **No `'unsafe-eval'` in CSP.** It crashes the manifest loader.
- **Worker import path is `/worker-entry`.** Don't change this; the flat barrel pulls in React UI which crashes the worker realm.
- **Background SW does not host the agent.** It only opens the chat tab. Adding agent code there breaks under MV3 SW CSP and lifecycle constraints.
- **API keys at build time.** `VITE_*` env vars baked into the bundle. Real apps must replace with `chrome.storage` + a settings UI.
