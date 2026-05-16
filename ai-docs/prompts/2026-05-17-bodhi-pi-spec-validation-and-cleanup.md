# Kickoff: validate `ai-docs/specs/bodhi-pi/` against source-of-truth + plan cleanup

**Output**: an exploratory plan with decision checkpoints — NOT a fire-and-forget execution. Write the plan to `ai-docs/plans/YYYY-MM-DD-bodhi-pi-spec-validation-and-cleanup.md` after you've grilled the user on the open questions. Do your own codebase exploration; use `AskUserQuestion` at every branch you can't resolve from code. Get plan approval before any code or doc edits.

## North star

`packages/bodhi-pi/` source code is the source of truth. The spec docs in `ai-docs/specs/bodhi-pi/` exist to make the architecture navigable for future AI agents and contributors. **When they disagree, code wins**, but the disagreement itself is interesting: it's either spec rot (update spec) or a hack the source has accumulated (fix source AND update spec).

This pass does both:
1. **Spec sync** — bring every spec doc into line with current source.
2. **Cleanup** — surface hacks, mixed-concern files, naming collisions, OAuth/in-memory/deprecated-package residue, and convoluted code that the spec sync exposes. Produce a follow-up cleanup plan.

The host/client folder split is a **separate prompt** (`2026-05-17-bodhi-pi-test-apps-host-client-split.md`) — do not do the split here, but the inventory you produce will feed it.

## Authority — read first (in this order)

1. `ai-docs/specs/bodhi-pi/index.md`
2. `ai-docs/specs/bodhi-pi/architecture.md`
3. `ai-docs/specs/bodhi-pi/acp.md`
4. `ai-docs/specs/bodhi-pi/lifecycle.md`
5. `ai-docs/specs/bodhi-pi/mcp.md`
6. `ai-docs/specs/bodhi-pi/extensions-skills-commands.md`
7. `ai-docs/specs/bodhi-pi/hosts.md`
8. `ai-docs/specs/bodhi-pi/testing.md`
9. `packages/bodhi-pi/CONTEXT.md`
10. `packages/bodhi-pi/CLAUDE.md`
11. `packages/bodhi-pi/PARITY.md`

Then walk source: `packages/bodhi-pi/src/`, `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext,node-adapters,app-utils}/src/`, `packages/bodhi-pi/test/`, `packages/bodhi-pi/e2e/`, `packages/bodhi-pi/e2e-ui/`.

## Scope (multi-select; user has confirmed all four)

### A. Spec sync — code as source of truth

A1. **Re-validate every `src/*` line-citation** across all spec files (e.g. `src/acp/agent.ts:339-356`). Citations rot the moment any file gains a line. Re-locate the cited symbol; if the code at that line moved, update the citation. If the behaviour at that line changed, update the spec body.

A2. **Inventory + Host/Client/Shared-classify every `test-apps/*/src/` file** and refresh `hosts.md`'s Host-vs-UI tables. Classification rule (CONFIRMED with user — see Vocabulary below):
   - **host/** = everything on the Host side of the ACP transport: `createBodhiPiAgent`, `AgentSideConnection` wiring, injected adapters (Filesystem/SessionStore/KvStore/ScriptExecutor/Terminal/McpConnectionProvider/extension factories), server endpoints, server-side MCP store, transport-server boundary.
   - **client/** = everything on the Client side of the ACP transport: `ClientSideConnection` wiring, transport-client adapters (http fetch+SSE, ws stream, MessagePort wiring), React components, REPL, slash dispatchers, renderer, client-side utilities.
   - **shared** = pure helpers usable from either side without protocol assumptions.

   The output is a per-file CSV/table you embed in `hosts.md`. Highlight every file that currently straddles — it's a seam violation we either split or justify.

A3. **Wire surface audit**: `src/wire/constants.ts` vs `acp.md`'s `_bodhi-pi/*` method table. `src/sessions/entries.ts` `SessionEntry` union vs `lifecycle.md`'s SessionEntry table. Catch added/removed/renamed methods and entry types. Re-validate `_meta["bodhi-pi"]` advertised capabilities and `LIFECYCLE_EVENT_METHOD` notification shapes.

A4. **Public-surface audit**: `src/index.ts` barrel, every `test-apps/*/package.json` `name` + `exports`, and `packages/bodhi-pi/CLAUDE.md` claims. Subpath exports (`/runtime`, `/ui`, `/lib/seed-parser`) are real consumer contracts the spec must list. CLAUDE.md drifts independently from specs.

### B. Hack / ambiguous-code hunt (all selected by user)

B1. **Mixed-concern files** — anything in `test-apps/*/src/` that imports BOTH `AgentSideConnection` (or `createBodhiPiAgent`) AND React (or `ClientSideConnection`). Also fan out `test-apps/browser/src/ui-lib/lib/*` (frame-log, seed-parser, slash-router, worker-fs-bridge, workspace-constants) — each consumer call site decides which side it lives on.

B2. **Naming collisions / duplicated stems** — known offenders:
   - `test-apps/chrome-ext/src/agent/sandbox.ts` AND `test-apps/chrome-ext/src/sandbox/sandbox.ts` (different roles: port-bridge vs MV3 iframe page). **User decision: do NOT rename — document the role of each in `hosts.md` and add a one-line header comment to each file describing its role.**
   - `test-apps/http/src/frontend/adapter-http.ts` AND `adapter-ws.ts` (two transports, parallel files). Document, don't rename.
   - Scan for other collisions you spot.

B3. **Residue of removed features**:
   - **OAuth removal** — `oauth` / `OAuth` / `EXT_MCP_OAUTH` should be zero hits in `src/`. Audit `CLAUDE.md` and `PARITY.md` for stale OAuth language.
   - **`test-apps/in-memory/`** — package was renamed to `test-apps/node-adapters/` in commit `b2399c26`. Hits in specs: `ai-docs/specs/bodhi-pi/index.md:19`, `ai-docs/specs/bodhi-pi/hosts.md:3`. Find more.
   - **Deprecated `packages/bodhi-pi-*`** — any non-historical reference outside those packages themselves.
   - **Dead imports / unreferenced modules** — particularly under `src/mcp/` after the Store/Lifecycle/Registry decomposition (check `mcp-client.ts` if it still exists, and any `mcp-auth*.ts` survivor — note `mcp-auth.ts` was renamed to `mcp-stdio-env.ts` in commit `d100bcc9`).

B4. **Holistic ugly-code sweep** (user explicitly requested):
   - Confusing branches, deeply-nested `if/else`, convoluted edge-case handling that hints at bad design.
   - Patched-up code (recent fixes layered on without refactor; look at `git log -p`'s last 50 commits for "fix:" patterns followed by `as any` or `// @ts-expect-error`).
   - `as any`, `// @ts-expect-error`, `// @ts-ignore`, `TODO`, `FIXME`, `HACK`, `XXX` in `src/` and `test-apps/`. Bucket by severity (cosmetic vs design-smell vs hidden-bug-risk).

### C. New spec docs to create

C1. **`ai-docs/specs/bodhi-pi/configuration.md`** (new file). Descriptive — document the THREE config layers as they exist today:
   - **Application-start config** — `BodhiPiConfig` passed to `createBodhiPiAgent` (required/optional fields, defaults, throw-at-construction rules).
   - **Session-mutable config** — `setSessionConfigOption` (model, thinking) + `_bodhi-pi/session/settings/{get,set,unset,list}` (arbitrary keys).
   - **Disk hierarchy** — `defaults < global < project < host-explicit < session`. Where each layer reads from. The `parseSettingValue` JSON-coercion behaviour. Global-only-on-Node-Hosts caveat.

   Include a final **Known weaknesses** section calling out fragmentation, surprise behaviours, and any redesign hints you discover. Do NOT propose the redesign here — point to a future ADR. (User flagged config as "not well planned out".)

C2. **`ai-docs/specs/bodhi-pi/client-sdk-seed.md`** (new file). Document `src/client/` — currently exports `BodhiPiClient`, `createBodhiPiClient`, `flattenModelOptions`, `modelConfigFromOptions`, `parseMcpAddArgs`, `formatProviderAuth`, `ParsedMcpAdd`, `BodhiPiClientOptions`. This is the seed of the future `@bodhiapps/bodhi-pi-client-common` SDK. Cover:
   - What `BodhiPiClient` wraps (it sits on top of ACP's `ClientSideConnection`).
   - What it does NOT cover (transport, React, slash UX).
   - Current consumers (cli REPL imports it; check whether http/browser frontends do too).
   - The seam with ACP SDK types — what's re-exported vs proprietary.

C3. **Update `architecture.md` `src/` layout** — currently missing `src/client/`. Add it; describe its role in one line; cross-link to `client-sdk-seed.md`.

### D. CONTEXT.md update (major)

D1. **Collapse Client / UI vocabulary**. CONTEXT.md currently distinguishes Client (ACP role) from UI (rendering surface) and lists "Client vs UI" as a flagged ambiguity. User has chosen to collapse: **Client = ACP-peer-side of Transport AND the folder name `client/`**; UI is a sub-concept (rendering layer that lives inside `client/`).

   Concrete edits:
   - Update the "Client" definition to say it owns everything Client-side of the Transport (rendering, slash UX, transport-client adapters, ClientSideConnection).
   - Demote "UI" to a sub-bullet under "Client": "**UI** — the rendering subset of Client (React components, REPL renderer, popup pages). Lives under `client/react/` (or equivalent)."
   - Rewrite the "Flagged ambiguity: Client" entry to say it's RESOLVED in favour of the collapsed vocabulary, and that the folder-split prompt is the operational consequence.

D2. Update `architecture.md` "The four roles" diagram + paragraph to reflect collapsed vocab. The diagram's `UI / Client` two boxes should merge into one `Client (incl. UI)` box.

### E. CLAUDE.md sync

E1. Audit `packages/bodhi-pi/CLAUDE.md` for: stale OAuth claims, stale `extensionFactories` optionality/required language, `supportsMcpStdio` defaults (CLAUDE.md says default `true` — verify against `src/acp/agent.ts`), and Client/UI terminology drift after D1.

E2. Audit `packages/bodhi-pi/PARITY.md` similarly.

## Conflict policy (user-confirmed)

- **Drift only (spec says X, source says Y)** → update spec to match source. Record the change in the run report's "Drift fixed" section with file:line citation on both sides.
- **Source is hacky** → include the source fix in the cleanup plan AND note that the spec must be updated AFTER the fix lands. Don't update the spec to document the hack.
- **Cannot judge from code alone** → `AskUserQuestion` before deciding. Batch related questions.

## Vocabulary (locked decisions)

- Folder split uses `host/` + `client/` — NOT `host/ui/`. The existing prompt `ai-docs/prompts/2026-05-16-bodhi-pi-test-apps-host-ui-split.md` is superseded by `2026-05-17-bodhi-pi-test-apps-host-client-split.md`.
- `client/` may have canonical sub-folders: `client/{react, acp, deps, lib}/`. cli has no `react/`. Sub-org is documented in the split prompt; this prompt only needs to NAME `client/` correctly in updated specs.
- The seam definition that goes into `hosts.md` and CONTEXT.md:
  > **host/** = everything on the Host side of the ACP transport.
  > **client/** = everything on the Client side of the ACP transport, including all rendering surfaces.
  > A file straddles the seam if and only if it imports from both `AgentSideConnection`/`createBodhiPiAgent` AND `ClientSideConnection`/React/REPL. Straddling files MUST be split or explicitly justified.

## Anti-patterns to avoid

- Don't update specs ahead of source — code is the source of truth.
- Don't scope-creep into the host/client folder split — that's a separate prompt. You only INVENTORY here.
- Don't propose new architecture; you document the current one and flag weaknesses.
- Don't silently fix code while updating a spec — separate the cleanup item in the plan so the user reviews each.
- Don't batch all spec edits into one mega-commit — slice per spec doc (one commit per doc updated) so review is tractable.

## Plan structure (mandatory sections)

When you write the plan after grilling the user, include:

1. **Goal restatement** — one paragraph quoting the seam definition.
2. **Drift report** — table: `spec file:line` → `source file:line` → resolution (`updated spec` / `flagged for cleanup` / `user-confirmed no-op`). One row per drift item.
3. **Hack/ambiguity report** — table: `source file:line` → category (mixed-concern / naming / residue / ugly-code) → recommended fix → severity (cosmetic / design / risk).
4. **New spec doc outlines** — `configuration.md` and `client-sdk-seed.md` section skeletons. Approve before writing the full docs.
5. **Per-commit slice** — propose one commit per spec doc updated + one commit for CONTEXT.md collapse + one for CLAUDE.md sync + one per ugly-code fix that's tightly bounded (no batch fixes).
6. **Verification commands** — for any code change: `npm run -w packages/bodhi-pi typecheck`, the relevant `npm run -w packages/bodhi-pi/test-apps/<host> ...`, plus any e2e that exercises the touched file. For spec-only commits: skim render in GitHub style.
7. **Out of scope** — explicitly: the host/client folder split, SDK package extraction, config redesign, deprecated `packages/bodhi-pi-*` deletion.

## Working style

- This is exploratory. Read code FIRST, then form questions, then batch them via `AskUserQuestion` (with your recommended answer per question, marked "(Recommended)").
- When you discover something surprising, don't decide unilaterally — surface it.
- Use `Plan` agent for design questions you can't resolve from the user.
- Get the user's approval on the WRITTEN PLAN before any edits.

## When done

Print: the plan path, the count of drift items found, the count of hack items found, and the count of decision-points the user resolved during the session. Do not start executing the plan in this round — the plan IS the deliverable.
