# bodhi-pi-chrome-ext

Reference Chrome extension host for `@bodhiapp/bodhi-pi`. **PoC** — proves the agent runs unchanged inside an MV3 extension. Counterpart to `bodhi-pi-web` (browser tab) and to the cli/ws/http hosts. Both browser hosts are thin consumers of `@bodhiapp/bodhi-pi-browser` (the shared workspace package that owns adapters + UI + runtime + stores).

Real apps that follow the same shape: a sidepanel + page-tools agent (Claude-in-Chrome style) and a bookmarks/history agent. They will reuse this PoC's recipe — extension page + Web Worker + shared package — and add their own tool surfaces.

All the bodhi-pi-* runtimes, including this are Proof of Concepts, so there is no production deployment of these PoCs, there is no backwards compatability requirement, no data migration requirment, makes development of bodhi-pi quicker with these PoCs checking it works in all runtimes.

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
- `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`. **`'unsafe-eval'` is forbidden in MV3 extension pages and dedicated workers** — Chrome rejects the manifest if it appears.
- `content_security_policy.sandbox` allows `'unsafe-eval' 'unsafe-inline' data:` so `AsyncFunction` and `data:text/javascript` ESM imports work inside the sandbox iframe only.
- `sandbox.pages: ["sandbox.html"]` declares the sandbox page; see "Sandbox bridge" below.

## Sandbox bridge

`run_script` (skill scripts) and `createBrowserExtensionLoader` both need code-eval primitives that MV3 forbids in the worker realm. The host bridges this gap:

- `sandbox.html` + `src/sandbox/sandbox.ts` — a sandboxed extension page that runs `AsyncFunction` and dynamic-imports `data:` URLs. Listens on a `MessagePort`.
- `src/agent/sandbox.ts:createSandboxPort()` — main-thread helper that loads the iframe (waits for the `bodhi-pi-sandbox-ready` handshake), opens a `MessageChannel`, transfers one port to the iframe and returns the other.
- `RuntimeProvider` is wired with `sandboxPortFactory={createSandboxPort}`; the runtime hands the port to the worker via `init.sandboxPort`.
- `bootstrapAgentWorker` — when `sandboxPort` is present, swaps in `createSandboxedBrowserScriptExecutor` and `createSandboxedBrowserExtensionLoader` (both from `@bodhiapp/bodhi-pi-browser`) instead of the direct-eval variants. `pi.on(...)` extension handlers stay in the sandbox; the worker registers wrappers that round-trip the event payload over the bridge.

Only `pi.on` is proxied today — `registerTool` / `registerCommand` / `registerProvider` throw inside the sandbox; add proxies if a real chrome-ext skill needs them.

## E2e

- Playwright launches `chromium.launchPersistentContext` with `--load-extension=<dist>` and `--headless=new` (headless by default). Set `HEADED=1` to run with a visible browser. Old headless does not load MV3 extensions; new headless (Chrome 119+) does.
- Specs are copied from `bodhi-pi-web/e2e/` verbatim. The only delta is `pages/ChatPage.ts:goto()` which navigates to `/index.html` (chrome-extension:// origins don't auto-resolve `/`).
- Fixture in `e2e/fixtures.ts` overrides `context` and `page` to use the persistent context.

## Source code rules

- **No `'unsafe-eval'` in `extension_pages` CSP.** It crashes the manifest loader. `'unsafe-eval'` belongs in `content_security_policy.sandbox` only, scoped to `sandbox.html`.
- **Worker import path is `/worker-entry`.** Don't change this; the flat barrel pulls in React UI which crashes the worker realm.
- **Background SW does not host the agent.** It only opens the chat tab. Adding agent code there breaks under MV3 SW CSP and lifecycle constraints.
- **API keys at build time.** `VITE_*` env vars baked into the bundle. Real apps must replace with `chrome.storage` + a settings UI.
- **Code-eval goes through the sandbox bridge.** Anything that would have used `Function`/`AsyncFunction`/`data:` ESM imports inside the worker must instead post over `SandboxBridge`. See `bodhi-pi-browser/src/sandbox/sandbox-bridge.ts`.
