# Kickoff: split `test-apps/*/src/` into `host/` + `client/` (supersedes 2026-05-16 host-ui-split)

**Output**: an exploratory plan written to `ai-docs/plans/YYYY-MM-DD-bodhi-pi-test-apps-host-client-split.md`. Do your own codebase exploration; batch decision points via `AskUserQuestion` (with your recommended answer per question). Get plan approval before any code edits.

> **Supersedes** `ai-docs/prompts/2026-05-16-bodhi-pi-test-apps-host-ui-split.md`. That earlier prompt used `ui/` for the Client-side folder; the user decided to name it `client/` instead (matches the ACP role; future SDK packages are `@bodhiapps/bodhi-pi-client-{common,node,http,websocket,browser,chrome-ext}`). Mark the old prompt superseded at its top before starting.

## North star — the seam

The four reference Hosts under `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext}/` each mix Host-side code (constructs `BodhiPiAcpAgent`, exposes it over an `AgentSideConnection`) and Client-side code (`ClientSideConnection`, rendering, slash UX, transport-client adapters). This prompt enforces a clean per-Host folder split so future SDK extraction (`@bodhiapps/bodhi-pi-agent-{...}` and `@bodhiapps/bodhi-pi-client-{...}`) becomes a copy-and-publish.

**Seam definition** (CONFIRMED with user):

- **`host/`** = everything on the Host side of the ACP transport — adapter construction, `createBodhiPiAgent` call, `AgentSideConnection` wiring, server-side HTTP endpoints, server-side MCP store, transport-server boundary, MV3 sandbox iframe page (chrome-ext).
- **`client/`** = everything on the Client side of the ACP transport, INCLUDING all rendering — React components, REPL, slash dispatchers, renderer, `ClientSideConnection` wiring, transport-client adapters (http fetch+SSE, ws stream, MessagePort client side, sandbox port factory).
- A file straddles the seam if and only if it imports from both `AgentSideConnection`/`createBodhiPiAgent` AND `ClientSideConnection`/React/REPL. Straddling files MUST be split or explicitly justified.

`client/` is allowed to have canonical sub-folders for further organisation:

| Sub-folder | Contains | Notes |
|---|---|---|
| `client/react/` | React components, CSS, REPL renderer | cli omits |
| `client/acp/` | `ClientSideConnection` factory, transport client adapter, slash router | every Host |
| `client/deps/` | client-side IO adapters: http fetch+SSE, ws stream, MessagePort wiring, sandbox port factory | varies per Host |
| `client/lib/` | pure utilities (parsers, formatters, event log) | as needed |

Free-form file placement inside each sub-folder is fine. Missing sub-folders are simply absent (do not create empty `react/` for cli).

## Authority — read first

1. `ai-docs/specs/bodhi-pi/architecture.md`
2. `ai-docs/specs/bodhi-pi/hosts.md` (especially the per-Host Host vs UI breakdowns — assume the host-vs-`ui` rows in the table are now host-vs-`client` rows)
3. `packages/bodhi-pi/CONTEXT.md`
4. `packages/bodhi-pi/CLAUDE.md` (Reference Hosts section)
5. The superseded prompt at `ai-docs/prompts/2026-05-16-bodhi-pi-test-apps-host-ui-split.md` — useful per-Host mapping table; substitute `client/` for every `ui/`.

If the spec-validation prompt (`2026-05-17-bodhi-pi-spec-validation-and-cleanup.md`) has already run, its **per-file Host/Client/Shared inventory table in `hosts.md` is your primary input**. If not, you must produce that inventory yourself before designing the split.

## Goal

Move every file under each test-app into the new layout:

```
test-apps/<host>/src/
├── host/        # Host-side: adapters, agent construction, ACP server, MCP store, sandbox-page
└── client/      # Client-side: React, ClientSideConnection, slash UX, client adapters
    ├── react/   (omitted for cli)
    ├── acp/
    ├── deps/
    └── lib/
```

Rough per-Host mapping to VERIFY against current code (do not encode this table into the plan without re-checking the actual files):

| Host | host/ candidates | client/ candidates |
|---|---|---|
| **cli** | `cli.ts`, `agent.ts`, `config.ts` | `repl/` (the REPL is the Client peer + renderer) — split internally into `client/acp/` (commands.ts, transport pair setup), `client/lib/` (helpers), no `react/` |
| **http** | `server/**` | `frontend/**` — `App.tsx`/`main.tsx`/`index.html`/`index.css` → `client/react/`; `adapter-http.ts`/`adapter-ws.ts`/`lib/acp-http-client.ts`/`lib/sse-parser.ts`/`lib/ws/*` → `client/acp/` + `client/deps/`; `lib/event-log.ts` → `client/lib/` |
| **browser** | `frontend/worker.ts`, `ui-lib/runtime/`, `ui-lib/filesystem/`, `ui-lib/sessions/`, `ui-lib/kv/`, `ui-lib/script-executor/`, `ui-lib/extensions/`, `ui-lib/sandbox/`, `ui-lib/transport/`, `ui-lib/lib/worker-fs-bridge.ts`, `ui-lib/lib/workspace-constants.ts` | `frontend/main.tsx`, `frontend/App.tsx`, `frontend/adapter.ts`, `frontend/lib/crypto-shim.ts`, `ui-lib/ui/**` → `client/react/`; `ui-lib/lib/seed-parser.ts`, `ui-lib/lib/slash-router.ts`, `ui-lib/lib/frame-log.ts` → `client/lib/` |
| **chrome-ext** | `worker.ts`, `agent/crypto-shim.ts`, `sandbox/sandbox.ts` (the MV3 iframe page) | `main.tsx`, `App.tsx`, `adapter.ts`, `agent/sandbox.ts` (the port-bridge factory belongs on the Client side because it produces the port the worker-Host receives via init message) |

**Browser is the messy one.** `ui-lib/` mixes Host adapters and UI components. Decision: **reshape `ui-lib/` into `ui-lib/host/` + `ui-lib/client/`** (option (a) from the superseded prompt), so chrome-ext can continue importing `@bodhiapp/bodhi-pi-test-app-browser/host/...` and `/client/...` subpaths cleanly. Subpath exports in `browser/package.json` need updating. (The user CONFIRMED this option.)

**chrome-ext naming collision** — `src/agent/sandbox.ts` and `src/sandbox/sandbox.ts` are NOT renamed (user decision); document the role of each at the top of the file as a one-line header comment, and reflect both roles in `hosts.md`'s file table.

`test-apps/node-adapters/` and `test-apps/app-utils/` are **shared infrastructure, not Hosts** — no `host/`/`client/` split for them. But they may grow (see § Shared interface types below).

## Shared interface types — move to `app-utils/` in the same commits

User-confirmed: this work happens INSIDE the host/client split commits, not deferred.

Candidates for `test-apps/app-utils/src/`:

- `TransportAdapter`, `ConnectCallbacks`, `ConnectResult`, `SetupFormValues` — currently in `test-apps/browser/src/ui-lib/ui/transport.ts`; consumed by http UI (`frontend/adapter-http.ts`) and chrome-ext UI (`adapter.ts`).
- Any other interface type currently in `browser/ui-lib/ui/*` that http or chrome-ext imports.
- `seed-parser.ts` belongs in `client/lib/` of browser per the table above — but if both http and browser parse the same seed format, consider promoting the parser too. **Decision point for the user.**

For each move:
1. Move the type-only declarations to `app-utils/src/<name>.ts`.
2. Re-export from `app-utils` index.
3. Update browser's `client/react/transport.ts` (or wherever it lands) to re-export from `app-utils` for backward compat OR drop the re-export and update http/chrome-ext imports directly.
4. Update `package.json` and any `tsconfig` path mappings.

## Constraints

1. **Behaviour-preserving.** No runtime change beyond import path updates. Every existing `npm run test`, `vitest`, `playwright` invocation passes unchanged.
2. **One commit per Host** (4 commits) + one optional 5th commit for spec updates (`hosts.md`, `architecture.md`, CONTEXT.md if the diagram changes) IF those weren't already updated by the spec-validation prompt's run.
3. Per-Host commit MUST update all consumers in the same diff: tsconfig path mappings, vite/playwright configs, e2e helpers, neighbouring test-app imports (chrome-ext consumes browser; http does NOT consume browser frontend lib in current source — verify).
4. No new files except moves + new barrel/index files when needed. No renaming of types. No behaviour refactor (the spec-validation prompt's plan owns those separately).
5. Browser + chrome-ext share imports — order the commits so browser lands first, then chrome-ext re-points to the new browser subpath exports.
6. After each move, verify `package.json` `exports` field — some consumers import via subpath.
7. **Anti-patterns to avoid:**
   - Don't name the folders `agent-side/`/`client-side/`. The spec uses `host/`/`client/`.
   - Don't propose renaming the two `sandbox.ts` files (user decision).
   - Don't pull adapter packages out of `node-adapters/` or `app-utils/`. They are not Hosts.
   - Don't touch deprecated `packages/bodhi-pi-*` directories.
   - Don't add new behaviour or "while we're here" refactors.

## Plan structure (mandatory sections)

1. **Goal restatement** — quote the seam definition and the sub-folder taxonomy.
2. **File mapping per Host** — full table: current path → new path, one row per file (or per group when obviously grouped). VERIFY by reading current `test-apps/*/src/` trees first. Flag any file that straddles the seam and propose how to split it (separate row).
3. **Shared interface type moves** — table: current location → `app-utils/` location → all import-site updates.
4. **Per-commit slice** — 4 Host commits (recommended order: cli → http → browser → chrome-ext, because chrome-ext depends on browser; but justify if you reorder) + optional 5th spec-update commit. For each: commit subject, files moved, consumers updated, exact `npm run`/`vitest`/`playwright` commands to verify.
5. **Risk register** — call out:
   - Circular-import risk if a `host/` file accidentally imports from `client/` (lint rule? convention only?).
   - chrome-ext's dependency on browser's exports.
   - Any place where a file mixes concerns and must be split before moving.
   - Subpath-export breakage if `package.json` `exports` isn't updated atomically.
   - vite-plugin-node-polyfills `Buffer` injection in worker bundles — verify after worker.ts moves.
6. **Verification matrix** — per Host: which `npm run` / `vitest` / `playwright` command to run after the commit lands. Include both unit and e2e suites.
7. **Out of scope** — explicitly: no behaviour changes, no MCP cleanup, no OAuth residue cleanup, no SDK package extraction (that's a future prompt).

## Decision points to surface via `AskUserQuestion`

Before writing the plan, expect to ask the user about:

- Files that straddle the seam (e.g. cli `cli.ts` wires both `AgentSideConnection` and the in-process client peer — does it stay in `host/`, get split, or move to a top-level `entry.ts`?). **User pre-confirmed: stays in `host/`.**
- Sub-folder placement inside `client/` for files that don't fit cleanly into `react/acp/deps/lib`.
- Whether to promote a parser (e.g. seed-parser) from `client/lib/` to `app-utils/` if multiple Hosts parse the same format.
- Ordering of the four commits (cli first vs http first), depending on which is the lowest blast radius.
- Whether to add an ESLint rule enforcing the `host/`-must-not-import-`client/`-and-vice-versa convention, or rely on review.

## When done

Print: the plan path, the 4–5 commit subjects in order, and the verification commands per commit. Do not start executing the plan in this round — the plan IS the deliverable. Code/folder moves happen in a separate session, ideally guided by `superpowers:executing-plans`.
