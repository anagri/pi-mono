# bodhi-pi/src/ runtime-neutralisation

## Context

`packages/bodhi-pi/` is a runtime-neutral agent meant to run unchanged across the four reference Hosts: `test-apps/cli` (Node), `test-apps/http` (Node server + browser React shell), `test-apps/browser` (Web Worker), `test-apps/chrome-ext` (MV3 service worker + sandbox iframe). Today the core still imports two Node-specific specifiers — `node:crypto` (for `randomUUID`) and `node:path` (for POSIX path manipulation) — across 21 files in `src/`. These imports leak into any browser bundle that pulls the `@bodhiapp/bodhi-pi` barrel.

This was made visible by the HTTP test-app's `npm run dev` failing at page load with:
```
Module "node:crypto" has been externalized for browser compatibility.
Cannot access "node:crypto.randomUUID" in client code.
  at Object.get (__vite-browser-external:node:crypto:3:11)
  at dist/extensions/runner.js:1:50
```
The client only imports the string constant `LIFECYCLE_EVENT_METHOD` from the barrel (`test-apps/http/src/client/acp/acp-http-client.ts:61`, `…/ws/transport.ts:8`), but the barrel re-exports `extensions/runner.ts` and friends, all of which start with `import { randomUUID } from "node:crypto"`. Vite-dev does not tree-shake the same way `vite build` does, so the whole graph evaluates and the externalised module trap fires on first binding read.

The HTTP test-app currently has **no countermeasures**; the browser test-app papers over the same issue with `vite-plugin-node-polyfills` + a `node:crypto` alias to a local shim (`test-apps/browser/vite.config.ts`). That polyfill is the only reason the browser app works — once `bodhi-pi/src/` is clean, it can be deleted.

The intended outcome:
- `bodhi-pi/src/` contains zero `node:*` imports.
- The `@bodhiapp/bodhi-pi` barrel is safe to import from any runtime (Node, browser, Worker, MV3 service worker).
- The HTTP test-app boots in a browser via `npm run dev` with no Vite config changes.
- The browser test-app drops its `node:crypto` alias and the `vite-plugin-node-polyfills` plugin (kept only for unrelated polyfills if any remain — confirm during execution).
- CLAUDE.md formalises the rule so this regresses loudly next time someone reaches for `node:*`.

The runtime-gated `await import("@modelcontextprotocol/sdk/client/stdio.js")` inside `src/mcp/mcp-client.ts:52` is **not** removed — it is the existing, intentional pattern for stdio MCP (CLAUDE.md "Transports" section). It only loads when `supportsMcpStdio: true`, so browser/MV3/HTTP Hosts (which pass `false`) never resolve it. That pattern stays.

## Approach

Two replacements, one shared rule:

1. **`node:crypto` → `globalThis.crypto.randomUUID()`** via a tiny in-house wrapper at `src/_internal/uuid.ts`. Web Crypto's `randomUUID` is available in Node ≥19, all modern browsers, Web Workers, and MV3 service workers — no polyfill needed, no new dependency. All 8 call sites use the result as an opaque ID (no slicing, parsing, or format dependence), confirmed by the Phase-1 inventory.

2. **`node:path` → `pathe`** (user-chosen). `pathe` is a runtime-neutral ESM POSIX path package, zero runtime deps, mirrors the full `path.posix.*` API. All 13 files use only POSIX-style forward-slash methods (frequency: `join` ×8, `dirname` ×5, `normalize` ×3, `relative` ×2, `isAbsolute` ×1, `basename` ×1). No `path.sep`, no `path.normalize` for cross-platform translation, no `process.cwd()`. Drop-in swap.

3. **CLAUDE.md rule** — extend the existing "No `node:fs` in core" source-code rule to "No `node:*` in core" with a one-line rationale and an exception note for the dynamic-import gating pattern in `mcp-client.ts`.

After core is clean, the browser test-app's `node:crypto` alias and (if it carried no other consumers) the polyfills config become dead weight and are removed in the same plan, proving the refactor end-to-end.

## Critical files

### Core swap — replace imports (21 files)

`node:crypto` → `@/_internal/uuid.js`:
- `src/acp/prompt-loop.ts:1`
- `src/extensions/runner.ts:1`
- `src/mcp/mcp-store.ts:1`
- `src/models/registry.ts:1`
- `src/sessions/compaction-orchestrator.ts:1`
- `src/sessions/in-memory-session-store.ts:1`
- `src/sessions/session-info-service.ts:1`

`node:path` → `pathe` (named imports throughout — drop `.posix.` prefix since `pathe` IS posix):
- `src/commands/discovery.ts:1` (`{ join }`)
- `src/filesystem/in-memory-filesystem.ts:1` (default → named `{ normalize, dirname, join }`)
- `src/sessions/resource-loader.ts:1` (default → named `{ join, normalize, dirname }`)
- `src/settings/settings-global.ts:1` (default → named `{ join }`)
- `src/settings/settings-writer.ts:1` (default → named `{ dirname, join }`)
- `src/settings/settings.ts:1` (default → named `{ join }`)
- `src/skills/discovery.ts:1` (`{ join }`)
- `src/tools/find.ts:1` (default → named `{ relative }`)
- `src/tools/grep.ts:1` (default → named `{ relative }`)
- `src/tools/index.ts:1` (default → named `{ isAbsolute, normalize, join }`)
- `src/tools/ls.ts:1` (default → named `{ join }`)
- `src/tools/walk.ts:1` (default → named `{ basename, join }`)
- `src/tools/write.ts:1` (default → named `{ dirname }`)

For files currently using `path.posix.X(...)`, also rewrite the call sites to drop the `path.posix.` prefix — `pathe`'s exports already are POSIX. (Mechanical sed-safe in most cases; verify each diff.)

### New files

- `packages/bodhi-pi/src/_internal/uuid.ts` — re-export wrapping `globalThis.crypto.randomUUID()` with a clear error if Web Crypto is absent. Mirror the shape of `test-apps/browser/src/client/lib/crypto-shim.ts` (already proven). ~10 LOC.

### Manifest

- `packages/bodhi-pi/package.json` — add `"pathe": "^X.Y.Z"` to `dependencies` (the version resolved during execution; latest is fine).

### Docs

- `packages/bodhi-pi/CLAUDE.md` — under "Source code rules", upgrade the bullet currently reading **"No `node:fs` in core, but `Filesystem`-based walks are allowed."** to a stronger rule banning all `node:*` imports in `src/`, with the rationale ("the barrel is imported from browser / Worker / MV3 runtimes — any `node:*` specifier traps when externalised by bundlers, breaking page load") and the one explicit exception (the dynamic `import("@modelcontextprotocol/sdk/client/stdio.js")` in `mcp-client.ts:52`, gated by `supportsStdio`). Also note `globalThis.crypto.randomUUID()` and `pathe` as the canonical replacements so future agents don't re-derive the choice.
- `packages/bodhi-pi/ai-docs/specs/bodhi-pi/architecture.md` (and `mcp.md` if it cites the rule) — touch only if existing text explicitly says "no `node:fs`" so the policy text stays consistent across spec and CLAUDE.md.

### Browser test-app cleanup

- `packages/bodhi-pi/test-apps/browser/vite.config.ts` — remove the `node:crypto`/`crypto` alias block, remove the `cryptoShim` constant, remove `vite-plugin-node-polyfills` and its `polyfills()` helper unless another importer in the worker graph still pulls `node:path`/`buffer`/etc. (Verify by running `npm run dev` in the browser test-app after the core swap and watching for any other `node:*` externalisation errors; if any surface, narrow the `include:` list rather than restore the whole plugin.)
- `packages/bodhi-pi/test-apps/browser/src/client/lib/crypto-shim.ts` — delete if no other importer exists (`rg "crypto-shim"` to confirm).
- `packages/bodhi-pi/test-apps/browser/package.json` — drop `vite-plugin-node-polyfills` from `devDependencies` if the plugin is removed.

### Test surface to re-run

- `packages/bodhi-pi/test/` (vitest) — unit tests that already assert tool/session behaviour. Should pass unmodified; if any test does `vi.mock("node:crypto", ...)` or `vi.mock("node:path", ...)`, update to mock the new module path. Phase-1 inventory found no such mocks, but re-grep before committing.
- `packages/bodhi-pi/test-apps/http/` — verify dev frontend boots.
- `packages/bodhi-pi/test-apps/browser/` — verify the worker still boots without the polyfills.

## Commit shape

Per the project's trunk-based development rule (each commit individually green on `npm run check` + `npm test`, parity commits run `just test-e2e` + `just test-e2e-ui`):

**Commit 1 — Core neutralisation + rule.**
- Add `pathe` to `bodhi-pi/package.json` dependencies.
- Add `src/_internal/uuid.ts`.
- Migrate all 21 `src/` files (imports + call-site `path.posix.X` → `X`).
- Update CLAUDE.md rule + linked spec text.
- Re-grep `src/` for `from "node:` — expect zero hits, including in tests.
- Run `npm run check`, `npm test` in `packages/bodhi-pi/`.

**Commit 2 — Reverse browser polyfills + matrix gate.**
- Strip `node:crypto` alias and (verified-unneeded) `nodePolyfills()` from `test-apps/browser/vite.config.ts`.
- Delete `test-apps/browser/src/client/lib/crypto-shim.ts` if unreferenced.
- Drop the `vite-plugin-node-polyfills` devDependency if no other consumer.
- Manually boot `test-apps/http` `npm run dev`, confirm no console exception at `http://localhost:5173/`.
- Manually boot `test-apps/browser` `npm run dev`, confirm worker comes up.
- Run `just test-e2e` + `just test-e2e-ui` (full matrix gate).

## Verification

1. **No `node:*` in core** — `rg "from \"node:" packages/bodhi-pi/src/` returns no matches.
2. **Type check** — `npm --workspace @bodhiapp/bodhi-pi run check` (or root `npm run check`) green.
3. **Unit tests** — `npm --workspace @bodhiapp/bodhi-pi test` green.
4. **HTTP dev boot** — `npm --workspace @bodhiapp/bodhi-pi-test-app-http run dev`, then open `http://localhost:5173/` in Chrome and confirm the console is free of `node:crypto`/`node:path` externalisation errors. (Use Claude-in-Chrome `read_console_messages` with pattern `crypto|externalized|node:` to assert empty.)
5. **Browser dev boot** — `npm --workspace @bodhiapp/bodhi-pi-test-app-browser run dev`, open the Vite URL, confirm the worker initialises and the React shell mounts without errors (despite the polyfills being gone).
6. **Matrix gate** — `just test-e2e` and `just test-e2e-ui` from repo root, both green. This is the contract that proves all four reference Hosts still pass on the trunk-based workflow.
7. **Regression guard** — CLAUDE.md now documents the rule; future agents reading the source-code-rules section see the ban and the rationale, so the next `import { randomUUID } from "node:crypto"` attempt should be rejected at code-review/commit time.
