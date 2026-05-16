# Kickoff: plan the `test-apps/*/src/{host,ui}/` folder split

**Output**: a written plan in `ai-docs/plans/YYYY-MM-DD-bodhi-pi-test-apps-host-ui-split.md` following the same shape as recent plans (`ai-docs/plans/20260514-solid-bodhi-pi-2.md`, `ai-docs/plans/20260515-mcp-3-connection.md`). Plan only — no code changes in this round.

## Authority

These specs are the source of truth. Read them first:

- `ai-docs/specs/bodhi-pi/index.md`
- `ai-docs/specs/bodhi-pi/architecture.md`
- `ai-docs/specs/bodhi-pi/hosts.md` ← especially the **Host vs UI** breakdowns per Host
- `packages/bodhi-pi/CONTEXT.md` ← Roles & processes (Host / Client / UI / Agent)

The CONTEXT.md term definitions are not negotiable; the plan must use them precisely. In particular: "Client" is the ACP `ClientSideConnection` peer (a protocol role), "UI" is the user-facing render surface. The folders are named `host/` and `ui/` — NOT `host/client/`.

## Goal

Move each of the four reference Hosts under `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext}/` to a clean folder split:

```
test-apps/<host>/src/
├── host/        # adapter construction, ACP AgentSideConnection wiring,
│                # server-side endpoints, MCP store, transport boundary
│                # ↳ contains all code on the Host's side of the ACP transport
└── ui/          # React components, REPL, slash dispatchers, ACP ClientSideConnection,
                 # client-side adapters (http fetch + SSE, ws stream)
                 # ↳ contains all code on the Client's side of the ACP transport
```

For the four hosts the rough mapping (verify against current code before encoding into the plan):

| Host | host/ candidates | ui/ candidates |
|---|---|---|
| cli | `cli.ts`, `agent.ts`, `config.ts` | `repl/` |
| http | `server/**` | `frontend/**` |
| browser | `frontend/worker.ts`, `ui-lib/runtime/`, `ui-lib/filesystem/`, `ui-lib/sessions/`, `ui-lib/kv/`, `ui-lib/script-executor/`, `ui-lib/extensions/`, `ui-lib/sandbox/`, `ui-lib/transport/` | `frontend/main.tsx`, `frontend/App.tsx`, `frontend/adapter.ts`, `frontend/lib/crypto-shim.ts`, `ui-lib/ui/**` |
| chrome-ext | `worker.ts`, `agent/`, `sandbox/` | `main.tsx`, `App.tsx`, `adapter.ts` |

`test-apps/in-memory/` and `test-apps/app-utils/` are **shared infrastructure**, not Hosts; they stay as-is.

The browser case is the messy one because `ui-lib/` currently mixes Host-side adapters and UI components. The plan must commit to a decision: either (a) keep `ui-lib/` and reshape into `ui-lib/host/` + `ui-lib/ui/`, OR (b) flatten `ui-lib/host/*` directly into `src/host/*` and `ui-lib/ui/*` into `src/ui/*`. Recommend (a) so chrome-ext can continue importing `@bodhiapp/bodhi-pi-test-app-browser/ui-lib/host/...` as a shared infrastructure layer — but justify.

## Constraints

1. **Behaviour-preserving.** No runtime change beyond import path updates. e2e suites must pass unchanged.
2. **One commit per host** (4 commits) plus one optional final commit to update spec docs / CLAUDE.md if any cross-cutting wording needs to follow.
3. Per-Host commit must update all consumers (tsconfig path mappings, vite/playwright configs, e2e helpers, neighbouring test-app imports — chrome-ext consumes browser; http consumes browser frontend lib).
4. No new files except moves + new index barrels if needed. No renames of types or refactor of behaviour.
5. Browser + chrome-ext share imports — coordinate so chrome-ext's commit re-points its imports to the new shared `ui-lib/host/` layout.
6. Verify each test-app's `package.json` `exports` field after the move; some consumers may import via subpath.

## Plan structure (mandatory sections)

1. **Goal restatement** — one paragraph; quote the role definitions from CONTEXT.md.
2. **File mapping per Host** — full table: current path → new path, one row per file (or per group when obviously grouped). Verify by reading current `test-apps/*/src/` trees before encoding.
3. **Per-commit slice** — 4 commits + optional 5th. For each: commit subject, files moved, consumers updated, test commands to verify.
4. **Risk register** — call out: (a) circular import risk if a "host/" file accidentally imports from "ui/", (b) chrome-ext's dependency on browser's exports, (c) any place where a file mixes concerns and must be split before moving.
5. **Verification matrix** — for each Host: which `npm run` / `vitest` / `playwright` command to run after the commit lands.
6. **Out of scope** — explicitly: no behaviour changes, no MCP cleanup, no OAuth-removal residue cleanup (those belong to the cleanup plan).

## Anti-patterns to avoid

- Don't propose renaming the folders to `agent-side/client-side/`; the user-facing spec uses `host/ui/`.
- Don't pull adapter packages out of `test-apps/in-memory/` or `test-apps/app-utils/`. Those are not Hosts.
- Don't touch `packages/bodhi-pi-*` (deprecated; the cleanup plan may deprecate-and-remove them later).
- Don't add new behaviour or "while we're here" refactors. Pure moves.

## When done

Print the plan path, the 4-5 commit subjects, and the verification commands per commit. No code edits in this round.
