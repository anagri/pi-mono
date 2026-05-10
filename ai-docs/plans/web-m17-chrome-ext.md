# bodhi-pi-chrome-ext — Chrome Extension PoC for bodhi-pi (with shared bodhi-pi-browser)

## Context

bodhi-pi today runs in four reference hosts (`bodhi-pi-cli`, `bodhi-pi-web`, `bodhi-pi-ws-server`+`-frontend`, `bodhi-pi-http`). We want to extend the runtime matrix with a fifth host — a Chrome extension — that proves the agent runs unchanged inside extension origins.

Two real apps follow once the PoC is green: a sidepanel-with-page-tools agent, and a bookmarks/history agent. Both share the same shape: an extension page that spawns a Web Worker hosting the bodhi-pi agent. The PoC validates that shape end-to-end.

This plan **reverses an earlier policy decision** for `bodhi-pi-browser`. It was previously scoped as a publishable adapter library ("no React, no UI"). It now becomes the shared *PoC infrastructure* workspace package. It contains adapters, agent runtime glue, React UI, zustand stores, workspace bootstrap, and env helpers. Both `bodhi-pi-web` and the new `bodhi-pi-chrome-ext` shrink to thin hosts that consume from this single package via a flat barrel.

The pivot pays off the moment we have two browser hosts: instead of duplicating ~25 source files, both hosts consume one source of truth. Future extensions (sidepanel, bookmarks) will follow the same recipe.

## Architecture

```
chrome-extension://<id>/index.html (React shell — bodhi-pi-chrome-ext)
        │ spawns                                    same shape as
        ▼                                           http://localhost:35173
   Web Worker (bodhi-pi agent)                      (bodhi-pi-web)
        │ ACP ndjson over MessagePort
        ▼
   ChatPage + EventsPanel
        ▲
        └── all imported from @bodhiapp/bodhi-pi-browser
```

Both hosts call the same `bootstrapAgentWorker()` in their workers and the same `startAgentRuntime(opts, worker)` on the main thread. Both render the same `<ChatPage/>` + `<EventsPanel/>`. Each host owns only: `main.tsx`, `App.tsx`, `index.css`/`App.css`, `env.ts` (5-line getter wrapper), `agent/worker.ts` (3 lines), `agent/runtime.ts` (5 lines), `agent/crypto-shim.ts` (vite-alias target), `vite.config.ts`, `index.html`, `package.json`, `tsconfig*`, plus its e2e suite.

`bodhi-pi-chrome-ext` adds `manifest.json`, `src/background.ts`, `scripts/gen-ext-key.mjs`, `scripts/copy-manifest.mjs`, and ext-flavored Playwright fixtures.

Background SW does **only** open the extension page on action click — no agent, no chrome.runtime relay. The agent lives in the Web Worker spawned from the page (MV3 SW cannot host Workers and disallows `unsafe-eval`, which `BrowserScriptExecutor` requires).

## Package matrix after refactor

| Package | Role | Shape |
|---|---|---|
| `bodhi-pi-browser` | **Shared PoC infrastructure** | adapters + runtime + UI + stores + workspace + env helper, flat barrel |
| `bodhi-pi-web` | Reference web host | thin: 8–10 host-specific files + e2e |
| `bodhi-pi-chrome-ext` | New extension host | thin: same as -web + manifest/background/key scripts + e2e |

## Refactor of `bodhi-pi-browser`

Drop publishability:
- `package.json`: `private: true`; remove `prepublishOnly`, `files` array; keep `exports` minimal (`.` → `dist/index.js`).
- `CLAUDE.md`: rewrite to reflect new role (PoC infrastructure, not publishable lib). Note new content (UI, runtime, stores, workspace).

Add dependencies:
- `@agentclientprotocol/sdk` (already transitive, make explicit)
- `@mariozechner/pi-ai`
- `react`, `react-dom` (peer-style; each host already brings them)
- `zustand`
- devDeps: `@types/react`, `@types/react-dom`

Update `tsconfig.build.json`:
- `lib: ["ES2022", "DOM", "DOM.Iterable", "WebWorker"]`
- `jsx: "react-jsx"`
- `types`: drop `node`-only assumption; runtime files use DOM types

Move existing `bodhi-pi-web` content into `bodhi-pi-browser/src/`:

| New shared file | Source in bodhi-pi-web |
|---|---|
| `src/runtime/types.ts` | `src/agent/types.ts` |
| `src/runtime/bootstrap-worker.ts` | extracted from `src/agent/worker.ts` body (everything after the `init` listener registration) |
| `src/runtime/runtime.ts` | `src/agent/runtime.ts` — accepts an already-spawned `Worker` arg instead of spawning |
| `src/runtime/render.ts` | `src/agent/render.ts` |
| `src/runtime/wire-tap.ts` | `src/agent/wire-tap.ts` |
| `src/runtime/session-storage.ts` | `src/agent/session-storage.ts` |
| `src/ui/*.tsx` and `commands.ts` | `src/ui/*` (verbatim) |
| `src/store/{chatStore,eventStore}.ts` | `src/store/*` (verbatim) |
| `src/workspace/{provider,bootstrap,types}.ts` | `src/workspace/*` (verbatim) |
| `src/env/env.ts` | `src/env.ts` — converted to `buildResolvedEnv(getEnvVar)` (caller injects `(k) => import.meta.env[k]`) |

Files that **stay host-local** (cannot live in shared because they're host-specific glue):
- `agent/worker.ts` — must live where Vite can locate it via `new URL("./worker.ts", import.meta.url)`. Each host's worker.ts is 3 lines: `import { bootstrapAgentWorker } from '@bodhiapp/bodhi-pi-browser'; bootstrapAgentWorker();`
- `agent/runtime.ts` — host spawns the Worker (URL resolution must happen in host source) then forwards to shared `startAgentRuntime`. 5 lines.
- `agent/crypto-shim.ts` — referenced by `vite.config.ts` alias; the alias path must be host-local.
- `env.ts` — calls shared `buildResolvedEnv((k) => import.meta.env[k])`. 5 lines.
- `index.css`, `App.css` — small enough that duplication is cheaper than CSS subpath gymnastics.
- `main.tsx`, `App.tsx`, `index.html`, `vite.config.ts`, `package.json`, `tsconfig*` — host-specific.

Update `bodhi-pi-browser/src/index.ts`: flat barrel re-exporting **everything** from existing adapter modules + new runtime/ui/store/workspace/env modules. (Single barrel per user decision.)

Existing vitest suite (filesystem, sessions, transport, script-executor, extensions) stays — must remain green after the changes.

## Refactor of `bodhi-pi-web`

Reduce `src/` to host-local files only. Replace local imports with shared:

```ts
// before
import { ChatPage } from "./ui/ChatPage";
// after
import { ChatPage } from "@bodhiapp/bodhi-pi-browser";
```

Files to **delete** from bodhi-pi-web/src:
- `agent/render.ts`, `agent/wire-tap.ts`, `agent/session-storage.ts`, `agent/types.ts`
- `ui/ChatPage.tsx`, `ui/Composer.tsx`, `ui/MessageList.tsx`, `ui/ToolCallCard.tsx`, `ui/EventsPanel.tsx`, `ui/StatusBar.tsx`, `ui/DirectoryGate.tsx`, `ui/RuntimeProvider.tsx`, `ui/commands.ts`
- `store/chatStore.ts`, `store/eventStore.ts`
- `workspace/bootstrap.ts`, `workspace/provider.ts`, `workspace/types.ts` (if present)

Files to **slim down**:
- `agent/worker.ts` → 3 lines
- `agent/runtime.ts` → 5 lines
- `env.ts` → 5 lines

Files **unchanged**: `main.tsx`, `App.tsx` (only import paths change), `agent/crypto-shim.ts`, `index.css`, `App.css`, `index.html`, `vite.config.ts`, `package.json` (deps unchanged — still pulls `@bodhiapp/bodhi-pi-browser` which now reaches further), `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `eslint.config.js`, `playwright.config.ts`, `e2e/**` (every spec), `public/`, `.env.example`, `.gitignore`.

Bodhi-pi-web e2e suite must stay green — this is the regression gate for the shared package.

## New package: `bodhi-pi-chrome-ext`

```
packages/bodhi-pi-chrome-ext/
  package.json
  tsconfig.json, tsconfig.app.json, tsconfig.node.json
  vite.config.ts                 # mirrors bodhi-pi-web + base:"./" + multi-input
  index.html
  manifest.json                  # MV3, key (committed), action wired to background
  public/
    icons/{16,32,48,128}.png
    favicon.svg
  scripts/
    gen-ext-key.mjs              # RSA 2048 → committed manifest.key + .ext-id
    copy-manifest.mjs            # post-build copy of manifest + icons → dist/
  src/
    main.tsx                     # ← copied from bodhi-pi-web
    App.tsx                      # ← copied from bodhi-pi-web (imports unchanged)
    App.css, index.css
    env.ts                       # 5-line shared buildResolvedEnv wrapper
    background.ts                # 5 lines: chrome.action.onClicked → tabs.create
    agent/
      worker.ts                  # 3 lines
      runtime.ts                 # 5 lines
      crypto-shim.ts             # copied from bodhi-pi-web
  e2e/
    fixtures.ts                  # launchPersistentContext + --load-extension
    helpers/{seed.ts}            # copied verbatim
    pages/{ChatPage.ts, EventsPanel.ts}  # copied verbatim
    data/                        # copied verbatim
    *.spec.ts                    # copied from bodhi-pi-web/e2e/
  playwright.config.ts
  .env.example
  .gitignore                     # key.pem, dist/, node_modules/, .ext-id*?
  CLAUDE.md, README.md, DEVELOPMENT.md
```

### `manifest.json`
```json
{
  "manifest_version": 3,
  "name": "bodhi-pi (PoC)",
  "version": "0.0.0",
  "description": "bodhi-pi agent inside a Chrome extension (PoC)",
  "key": "<base64 SPKI from gen-ext-key.mjs>",
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "Open bodhi-pi", "default_icon": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" } },
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; object-src 'self'"
  }
}
```

`unsafe-eval` is required by `BrowserScriptExecutor`'s AsyncFunction. PoC tests don't exercise `run_script`, but we set the CSP correctly so the parity claim holds.

### `vite.config.ts` differences from bodhi-pi-web
- `base: "./"` (relative URLs work under chrome-extension://).
- `build.rollupOptions.input`: `{ index: "index.html", background: "src/background.ts" }`.
- `build.rollupOptions.output.entryFileNames`: emit `background.js` at fixed path; other entries hashed.
- Post-build hook (Vite plugin `closeBundle` or npm script) calls `scripts/copy-manifest.mjs` to copy `manifest.json` + `public/icons/` into `dist/`.
- No `server.port` constraint (no dev server needed for the extension; build-watch is the dev loop).
- Same node polyfills, worker config, and `node:crypto` shim alias as bodhi-pi-web.

### `playwright.config.ts` differences
- No `webServer`.
- `use.baseURL` becomes `chrome-extension://<extId>` read from `.ext-id`.
- Single project; per-test `context` fixture creates a `chromium.launchPersistentContext("", { args: ["--disable-extensions-except=<dist>", "--load-extension=<dist>", "--no-sandbox"] })`.

### `e2e/fixtures.ts` differences
- Override the default `context` fixture to be the persistent context above.
- Override the default `page` fixture to call `context.newPage()`.
- Inject seed via `addInitScript` exactly as bodhi-pi-web does.
- Specs (`chat.spec.ts`, `events.spec.ts`, etc.) are copied verbatim — they hit `chat.goto()` which uses `baseURL`, so the only adapter is `baseURL`.

### `scripts/gen-ext-key.mjs`
- Generate 2048-bit RSA keypair using `node:crypto`.
- Write `key.pem` (gitignored).
- Export public key as DER, base64 → patch `manifest.json` `key` field.
- Compute extension id: SHA-256 of DER public key, take first 32 hex chars, map `0–9a–f → a–p` → write `.ext-id` (committed so e2e + manual loading don't drift).

### `scripts/copy-manifest.mjs`
- After `vite build`, copy `manifest.json` + `public/icons/*` to `dist/`.
- Verify presence of `dist/index.html`, `dist/background.js`, `dist/manifest.json`.

## E2e specs to port

All existing `bodhi-pi-web/e2e/` specs — full parity per user decision. List from the file tree:
- `chat.spec.ts`
- `events.spec.ts`
- `commands.spec.ts`
- `cross-provider.spec.ts`
- `extensions.spec.ts`
- `fs-tools.spec.ts`
- `model-persists.spec.ts`
- `model-switch.spec.ts`
- `scripted-skill.spec.ts`
- `sessions.spec.ts`
- `skills.spec.ts`
- `tool-failure.spec.ts`
- `tool-replay.spec.ts`
- `workspace.spec.ts`

The `e2e/data/`, `e2e/examples/`, `e2e/helpers/seed.ts`, `e2e/pages/*`, `e2e/fixtures.ts` come along.

## Implementation phases

**Phase A — bodhi-pi-browser becomes the shared package (no host churn yet)**
1. Add new deps + devDeps to `bodhi-pi-browser/package.json`.
2. Create new dirs/files in `bodhi-pi-browser/src/` (runtime, ui, store, workspace, env). Copy content from bodhi-pi-web.
3. Convert `env.ts` to parameterized `buildResolvedEnv(getEnvVar)`.
4. Refactor `bootstrap-worker.ts` to export `bootstrapAgentWorker()` (the listener registration, not the worker entry).
5. Refactor `runtime.ts`'s `startAgentRuntime` to accept a pre-spawned `Worker` (host owns the spawn).
6. Update `tsconfig.build.json` for JSX + DOM lib.
7. Flatten `src/index.ts` to a single barrel exporting EVERYTHING.
8. Update `package.json`: `private: true`, drop `prepublishOnly` + `files`.
9. `npm run build` (tsgo) inside the package — must succeed.
10. `npm run test` (vitest) — existing 25 tests must remain green.

**Phase B — refactor bodhi-pi-web to consume shared**
11. Delete duplicated files (`agent/render.ts`, `agent/wire-tap.ts`, `agent/session-storage.ts`, `agent/types.ts`, `ui/*` except css, `store/*`, `workspace/*`).
12. Slim `agent/worker.ts` to 3 lines, `agent/runtime.ts` to 5 lines, `env.ts` to 5 lines.
13. Update `App.tsx` imports to point at `@bodhiapp/bodhi-pi-browser`.
14. `npm run build` succeeds.
15. `npm run test:e2e` — all existing specs remain green. **Regression gate.**

**Phase C — build bodhi-pi-chrome-ext**
16. Scaffold package: `package.json`, tsconfigs, vite.config, manifest, index.html, .env.example, .gitignore, CLAUDE.md, README.md.
17. Add `scripts/gen-ext-key.mjs` and `scripts/copy-manifest.mjs`. Run gen-key once; commit `manifest.json` + `.ext-id`.
18. Create `src/`: copy `main.tsx`, `App.tsx`, `App.css`, `index.css`, `agent/crypto-shim.ts` from bodhi-pi-web; write 5-line `env.ts`, 3-line `worker.ts`, 5-line `runtime.ts`, 5-line `background.ts`.
19. `npm install` at root (workspace), then `npm run build` in the new package — verify `dist/` has `index.html`, `manifest.json`, `background.js`, `assets/*`.
20. Manual smoke: load `dist/` unpacked in Chrome, click action, confirm chat works against a real key.
21. Copy e2e/ tree from bodhi-pi-web; adjust `e2e/fixtures.ts` to use `launchPersistentContext` + `--load-extension`; adjust `playwright.config.ts` (drop webServer; baseURL from `.ext-id`).
22. `VITE_OPENAI_API_KEY=… VITE_ANTHROPIC_API_KEY=… npm run test:e2e` — full spec parity green.

## Verification

End-to-end test plan:

1. From repo root: `npm install`.
2. `cd packages/bodhi-pi-browser && npm run build && npm run test` — vitest green.
3. `cd ../bodhi-pi-web && npm run build && npm run test:e2e` — Playwright green (regression gate proves the shared refactor preserves behavior).
4. `cd ../bodhi-pi-chrome-ext && npm run gen-key` (once) → produces `manifest.json` with key + `.ext-id`.
5. `cp .env.example .env` and fill in `VITE_OPENAI_API_KEY` + `VITE_ANTHROPIC_API_KEY`.
6. `npm run build` — produces loadable `dist/`.
7. Manual: `chrome://extensions` → Load unpacked → select `dist/` → confirm id matches `.ext-id`. Click action → tab opens at `chrome-extension://<id>/index.html` → grant FSA → send "Reply with the single word: ping" → assistant replies, EventsPanel shows lifecycle + wire rows.
8. `npm run test:e2e` — full spec parity green.

## Reused functions / files (no reinvention)

- `@bodhiapp/bodhi-pi`: `createBodhiPiAgent`, `AgentSideConnection`, `ndJsonStream`.
- `@bodhiapp/bodhi-pi-browser` (post-refactor): all adapters + runtime + UI + store + workspace + env helper.
- bodhi-pi-web's existing source modules — moved into bodhi-pi-browser, not rewritten.

## Out of scope (PoC bounds)

- Content scripts, page-DOM tools, chrome.bookmarks/history tools (those are the next two real apps).
- chrome.storage settings UI for API keys (build-time .env only for PoC).
- Popup or sidepanel UI surfaces (full extension page only).
- CRX packaging for Chrome Web Store distribution; we sideload from `dist/`.
- Extracting `bodhi-pi-browser`'s existing publishability invariants (we explicitly drop them).

## Open risks

- **`unsafe-eval` in `manifest.content_security_policy.extension_pages`**: required by `BrowserScriptExecutor`. PoC e2e doesn't directly exercise `run_script`, but `scripted-skill.spec.ts` does. If it fails, this is the first place to check.
- **Vite worker URL resolution at extension origin**: `new Worker(new URL('./worker.ts', import.meta.url), { type: "module" })` with `base: "./"` produces a relative path. If the worker fails to load, verify emitted asset paths.
- **Playwright headless + extensions**: MV3 extensions need new headless mode; if specs flake, switch to headed + `xvfb-run` in CI.
- **tsgo + JSX**: tsgo (typescript-native-preview) may have JSX edge cases. If `npm run build` fails inside bodhi-pi-browser, pin to standard `tsc` for that package only.
- **CSS in shared package**: not attempted; CSS stays host-local. If we later want one CSS source, add a subpath export — out of scope here.
