# Round-2 review prompt for `bodhi-pi/src/`

> Pass this entire file verbatim as the user input to `/bodhi-pi-review`.

---

Run a fresh review of `packages/bodhi-pi/src/` only (no test/e2e/adapter changes). Round-1 just shipped — see commits `ef1a74f6`, `cdc4804a`, `91c7103f` (plan: `ai-docs/plans/lets-plan-the-cleanup-harmonic-dragon.md`, prior review: `ai-docs/reviews/2026-05-14-bodhi-pi-src-cleanup.md`). `agent.ts` is now ~800 lines and the work is decomposed into `*Service` classes + `ModelRegistry` + `CompactionOrchestrator` + free-function `session-bootstrap`. Round-2 is a tighter pass: now that the modules exist, are they shaped correctly?

## Goals (in priority order)

1. **Module self-containment.** Each top-level folder (`acp/`, `kv/`, `settings/`, `sessions/`, `extensions/`, `commands/`, `skills/`, `tools/`, `filesystem/`, `events/`, `script-executor/`, `core/`, `client/`, `_internal/`) should own everything needed to implement its slice. A module reaching into another module for implementation (vs. for a clean interface) is a finding.
2. **ACP folder = pure composition/coordination.** `acp/` should host the agent shell that composes concrete implementations from the domain modules, then delegates. Code inside `acp/` that operates within a single non-ACP domain belongs in that domain's folder. Code inside a domain folder that depends on ACP-specific concerns is also suspect — flag both directions.
3. **Dependency-graph hygiene.** Inter-folder edges should flow one way (downward toward domains, with `acp/` at the top as the composer). Reverse edges (a domain module importing from `acp/`) are the strongest smell. Cycles (even transitive) are blocking findings.
4. **Decouple via interfaces where dependencies are real.** Where module B legitimately needs something from module A, prefer "B declares an interface; A's concrete satisfies it" over "B imports A's concrete directly." The agent's composition root wires concrete into interface.
5. **Comment hygiene.** Round-1 added many JSDoc blocks during the extraction work. Many explain *what* (covered by names) instead of *why* (non-obvious invariants/constraints). Trim aggressively per `bodhi-pi/CLAUDE.md` comment policy: default to no comment unless removing it would surprise a future reader. Multi-paragraph docstrings on private methods are almost always too verbose.

## Suspect areas — investigate, propose, don't assume

These are pointers to where the round-1 shape looks wrong, not prescriptions. Validate each independently and let the analysis disagree where warranted.

- **`acp/model-registry.ts`.** It implements a domain (model catalog + provider auth resolution + model picker + thinking-level mutations + config-option builders). The agent composes it once. Is "model registry" actually an ACP concern, or does it belong in a `models/` (or `providers/`) folder, with `acp/` reaching down to compose? Map every method against this question.
- **`acp/session-state.ts`.** Defines `SessionState`, `SessionRuntime`, `SettingsState`, `ResolvedRetryOptions`. These are mutated by services in `kv/`, `settings/`, `sessions/`. Every service that touches a session imports this from `acp/`. Does the type belong where it is, or somewhere that domain modules can own without reaching back into `acp/`?
- **`acp/_helpers.ts`.** Mixed concerns — `validateSessionId` and `requireStringParam` are wire-validation; `requireSession` and `requireSessionRecord` operate on the agent's `sessions` Map + `sessionStore`. Are these one helper class or two? Should validation primitives live in `_internal/`?
- **`acp/constants.ts`.** Holds every `EXT_*` method-name string. Each service currently imports the subset relevant to it. Would these constants make more sense co-located with the service that owns the method (e.g., `kv/kv-service.ts` owns `EXT_KV_*`)? Single point of definition is the trade-off — but it may be worth the inversion.
- **`acp/notifications.ts`.** Marked `@internal`. Mixed: pi-agent-core → ACP wire converters (`agentToolContentForAcp`, `mapStopReason`) and content extractors (`extractText`, `extractToolCalls`) that aren't strictly ACP-specific. The orchestrator, graph-service, info-service all import from here. Is this one module or two? Should the non-ACP-shaped helpers move?
- **`sessions/compaction-orchestrator.ts`, `sessions/session-graph-service.ts`, `sessions/session-info-service.ts`.** All three reach into `acp/_helpers`, `acp/constants`, `acp/session-state`, and (orchestrator + graph) `acp/notifications`. Inventory which of those imports could be eliminated by moving the dependency or introducing an interface. The cleanest signal will be: does the service genuinely need ACP-shaped types, or only domain types that happen to live in `acp/`?
- **`sessions/`** folder is large (10 files mixing types, store impls, pure helpers, services). Is it cohesive enough as one folder, or are there at least two distinct sub-modules (e.g., session-store + entries types vs. service classes vs. compaction algorithms)? Don't force a split, but evaluate.
- **`kv/kv-service.ts`, `settings/settings-service.ts`.** Both depend on `acp/_helpers`. The validation path here uses `requireSession` (which needs the live session Map). Is the Map a hard dependency, or could the agent pass the resolved `SessionState` to the service method directly so the service doesn't reach into the agent's Map at all?
- **`extensions/runner.ts`.** Depends on `commands/prompt-templates`, `events/types`, `sessions/session-store`. The `sessions/session-store` import is for `appendEntry` — runner persists `extension` entries via the store. Is that the right coupling shape, or should the agent intermediate (extension calls `pi.appendEntry` → agent appends, runner stays pure)?
- **`client/client.ts`, `client/config-options.ts`.** Public typed surface that imports from `kv/auth-format` and `acp/constants`. Verify whether these imports represent legitimate public-surface dependencies or whether the client should consume only types defined in `client/types.ts`.
- **`core/`.** Shrunk to two files (`resource-loader.ts`, `system-prompt.ts`). Is `core/` still a meaningful folder name, or should those two relocate (e.g., resource-loader near where context files are loaded, system-prompt near where it composes)?
- **`_internal/object.ts`.** Defines `pickDefined` — round-1 didn't apply it at the 26+ ternary-spread sites in `agent.ts` and `client.ts`. Decide: apply now, or remove the unused helper.
- **Comment density.** Specific suspects (sampled from round-1 work): `kv/kv-store.ts` (multi-paragraph contract on `KvStore`), `filesystem/filesystem.ts`, `sessions/session-store.ts`, `acp/agent.ts` constructor wiring + each service registration. Scan every file added or modified in the three round-1 commits and propose what to delete vs. keep.
- **`_internal/awaitable.ts`.** One-liner type alias in its own file. Pulling its weight, or should it merge with `_internal/object.ts` or another internals home?

## Methodology suggestions

Pick whatever combination fits — no mandate on tooling.

- **Dependency graph.** Either run a tool (`npx madge --extensions ts --circular src/`, `npx madge --extensions ts --image deps.png src/index.ts`, `npx dependency-cruiser --output-type dot src | dot -Tpng`) or hand-walk via `grep -rn "^import" src/`. Output a folder-level matrix or DAG. Specifically call out: (a) cycles, (b) every reverse edge (domain → `acp/`), (c) the count of `acp/` imports per domain module.
- **Per-module "self-containment" audit.** For each domain folder, list: (1) every external import it makes, (2) every import it receives from outside, (3) which of those edges could be inverted (interface in the consumer, concrete in the producer), (4) which could be removed entirely (helper relocated, type co-located).
- **ACP-as-composer audit.** For each file under `acp/`, classify as: (a) ACP wire/protocol concern, (b) cross-module composition, (c) single-module implementation misplaced. Group (c) items by their natural home.
- **Comment audit.** Walk every `src/**/*.ts` file modified in commits `ef1a74f6`, `cdc4804a`, `91c7103f`. For each multi-line JSDoc block: justify with one sentence why a reader needs it. If the justification is "explains what the function does," it's a candidate for deletion.

## Deliverable

A `ai-docs/reviews/<YYYY-MM-DD>-bodhi-pi-src-cleanup-round-2.md` findings doc, following the same conventions as the round-1 review (`ai-docs/reviews/2026-05-14-bodhi-pi-src-cleanup.md`): actionable findings only, file:line cites on every claim, suggested commit grouping at the end. **Do not modify code in this pass** — analysis + proposal only. The findings doc should answer:

1. **Dependency map.** A folder-level summary (text or rendered graph) of cross-folder edges, with cycles and reverse edges called out.
2. **Move list.** Files/symbols that round-1 placed in the wrong folder, with the proposed destination per file and one-sentence justification.
3. **Interface introductions.** Where a real cross-module dependency exists, the proposed interface (which module declares, which concrete implements, where the composition root wires it).
4. **Comment deletions.** A targeted list of comments to remove (cite each). Per the comment policy, the bar is "would a reader miss this if it were gone?"
5. **Commit grouping.** Three commits (per the standing rule that bodhi-pi refactor passes group into ~3 broad commits to keep the matrix gate-check cost manageable). Each commit independently gate-checkable.

## Out of scope

- Test changes — `test/`, `e2e/`, adapter packages, reference hosts. (Test files may need import-path updates if a move lands; that's mechanical, not part of this analysis.)
- The deferred D.1 `ExtMethodSpec` typed-dispatch overload work — separate follow-up.
- Package export surface (subpath exports, in-memory helpers, typebox surface) — separate "publish surface" pass.
- Behaviour changes — this is a structure/clarity pass, not a feature pass.

## Constraints

- Every finding cites `file:line`. No cite ⇒ rejected.
- No hedging language ("Recommended", "Consider", "May want to"). Imperative.
- The findings doc itself should be tight — no narrative, no "what was considered/dropped" sections.
- Don't propose changes that contradict the existing round-1 design without explaining what changed in your analysis that the round-1 plan missed.
