# Maximize shared/e2e coverage of bodhi-pi features

## Context

Now that `e2e/shared/*` runs across all three runtimes (in-memory, cli, http) with 55 passing tests, the next leverage point is **maximum feature coverage per test file** — pick up ACP-visible surfaces that have zero or partial e2e coverage today. The shared-e2e suite is the highest-ROI signal we have: one test file proves the feature works under the real ACP wire across three transports.

This plan is the output of a thorough analysis:
- `packages/bodhi-pi/src/` — every ACP-visible surface (sessions, settings, KV, extensions, events, compaction, model selection, cancellation).
- `packages/bodhi-pi/e2e/shared/` — the 9 existing test files and what they assert.
- `packages/coding-agent/` — the source codebase bodhi-pi was ported from, used to validate that nothing we should be exposing has gone missing.
- `packages/agent/` — pi-agent-core's inner-loop surface, used to confirm which agent-loop features actually bubble up at the ACP boundary.

User-confirmed decisions:

1. **Scope**: cover all HIGH + MEDIUM gaps and consolidate where flow-conventions allow.
2. `registerCommand` goes into `extensions.e2e.ts` as a 6th fixture (same pattern as the other 5).
3. **Skip auto-compaction** (manual `/compact` already covered; auto-trigger costs too much runtime to prove). TODO comment in `compaction.e2e.ts`.
4. **Cancellation** uses a faux provider with delayed streaming for the deterministic in-memory test; a separate real-LLM cancel-mid-stream test runs across all 3 runtimes.

## Gaps to close (ordered by phase)

### HIGH (no coverage today)

- `_bodhi-pi/session/settings/{get,set,unset,list}` — three-tier hierarchy, dotted-key paths.
- `_bodhi-pi/kv/{get,set,list,remove}` — secrets masking (`***` over the wire), `AUTH_PREFIX = "auth/"`, `AuthChangeEvent`.
- Sessions lifecycle beyond new/fork/clone: `_bodhi-pi/session/list`, `close`, `delete`, `resume`.
- `cancel()` ACP method → `stopReason: "cancelled"`.
- Custom `systemPrompt` / `appendSystemPrompt` / AGENTS.md+CLAUDE.md ancestor walk.

### MEDIUM (touched but not asserted)

- Extension `registerCommand` (the four existing fixtures cover `pi.on`, `registerTool`, `registerProvider`; `registerCommand` is missing).
- Thinking level (`THINKING_CONFIG_ID` picker, `/thinking`, `ThinkingChangeEntry`).
- Token / turn limits → `stopReason: "max_tokens"`.

### Consolidations

- `fs.e2e.ts` (2 separate Haiku tests, identical setup) → single flow with three soft-assertion steps (write → read → grep).
- `events.e2e.ts` (2 separate gpt-4o-mini tests, identical setup) → single flow with two prompt cycles, `await h.flushEvents()` between.

## End state

- 13 (or 14) shared e2e test files; same 3-runtime matrix; **62-ish passed / 0 skipped**.
- Every HIGH-gap surface has a dedicated test file with an explanatory header comment.
- Every MEDIUM-gap surface is covered either via an extension to an existing file or its own focused test.
- `production` packages (`bodhi-pi-cli`, `bodhi-pi-http`, `bodhi-pi-node`, `bodhi-pi-browser`) untouched.

## Critical files

### New

- `packages/bodhi-pi/e2e/shared/settings.e2e.ts` — flow test for `_bodhi-pi/session/settings/*` extMethods.
- `packages/bodhi-pi/e2e/shared/kv.e2e.ts` — flow test for `_bodhi-pi/kv/*` + secrets masking + `AuthChangeEvent`.
- `packages/bodhi-pi/e2e/shared/sessions.e2e.ts` — flow test for list/close/resume/delete across two sessions.
- `packages/bodhi-pi/e2e/shared/system-prompt.e2e.ts` — custom `systemPrompt`, `appendSystemPrompt`, AGENTS.md/CLAUDE.md walk.
- `packages/bodhi-pi/e2e/shared/cancel.e2e.ts` — cancellation with faux-provider delay (in-memory) + real-LLM cancel-mid-stream (all runtimes).
- `packages/bodhi-pi/e2e/data/register-command/.bodhi-pi/extensions/register-command.js` — new fixture.
- `packages/bodhi-pi/e2e/data/system-prompt/.bodhi-pi/{AGENTS.md, ...}` — fixture for AGENTS.md walk if needed (decide during phase 3).

### Modified

- `packages/bodhi-pi/e2e/shared/extensions.e2e.ts` — add 6th test for `register-command` fixture.
- `packages/bodhi-pi/e2e/shared/chat.e2e.ts` — add `stopReason: "max_tokens"` assertion (low-maxTokens turn) and a thinking-level switching test.
- `packages/bodhi-pi/e2e/shared/fs.e2e.ts` — consolidate the 2 tests into 1 flow.
- `packages/bodhi-pi/e2e/shared/events.e2e.ts` — consolidate the 2 tests into 1 flow with `flushEvents` between.
- `packages/bodhi-pi/e2e/shared/compaction.e2e.ts` — add a TODO header comment noting auto-compaction is deferred.
- `packages/bodhi-pi/e2e/helpers/harness.ts` — if needed, expose a `fauxProvider` knob for the cancel test's in-memory case (decide during phase 4).

## Reuse / patterns

- Soft-assert flow tests follow the convention in `e2e/shared/commands.e2e.ts` and `fork-clone.e2e.ts` — single `createE2EHarness` + multiple `expect.soft(...)` steps.
- The `bodhiPiFixture` option (from the extensions work) handles `.bodhi-pi/` snapshots across runtimes; reuse for any test that needs project-rooted config.
- `harness.events` + `flushEvents()` (from the events work) is the sync barrier between `prompt()` and event assertions; reuse where event observation is needed.
- `harness.filesystem` is the live FS handle (in-memory map for in-memory, real tmpdir for cli/http) — use for seeding ad-hoc files.
- For the faux-provider cancel test, leverage `@test/helpers/registerFauxProvider` (already used in unit tests under `test/`). The path may need a small helper on the e2e harness to register it before agent boot.

## Implementation phases (depth-first per memory)

One commit per phase. Each phase ends with the new/modified file(s) green under all 3 runtimes (unless explicitly noted), then a `just test` regression check.

### Phase 1 — Settings + KV/auth (foundational extMethods, no LLM needed)

Goal: cover the two pure-extMethod surfaces in one commit. Neither requires a real LLM — flow uses `initialize` → optional `newSession` → extMethod calls + assertions on responses.

1. Write `settings.e2e.ts`:
   - Flow: set a project setting via `extMethod("_bodhi-pi/session/settings/set", { scope, key, value })`; list; get; set a session-scoped override; list (effective merge); unset project; list again.
   - Assert each tier resolves correctly and dotted-key paths work.
   - Faux provider not needed; pass a no-op model and never call `prompt()`.
2. Write `kv.e2e.ts`:
   - Flow: `set("auth/openai", "sk-xxx", { secret: true })`; `get` — assert returns `"***"` (masked); `list` — assert values masked; verify in-process `AuthChangeEvent` via `harness.events` (in-memory only — use `runIf(isRuntime("in-memory"))` if cli/http don't surface it on this channel); `remove`; `get` returns `undefined`.
   - For cli/http: `harness.events` may not carry AuthChangeEvent without the event channel wired; assert KV ops + masking only.
3. Run `npm run test:e2e -- --project in-memory settings.e2e.ts kv.e2e.ts` → green.
4. Repeat for `--project cli` and `--project http`.
5. `just test` regression.
6. Commit: `bodhi-pi e2e: settings + kv extMethod coverage (settings.e2e.ts, kv.e2e.ts)`.

### Phase 2 — Sessions lifecycle (list / close / resume / delete)

1. Write `sessions.e2e.ts` with one flow:
   - `newSession A`; prompt (real LLM, gpt-4o-mini, one short turn); `listSessions` — A appears.
   - `newSession B`; `listSessions` — both appear.
   - `closeSession A`; `listSessions` — A still listed (close ≠ delete).
   - `resumeSession A`; prompt — assert response references the earlier turn (e.g., "what did I just ask?").
   - `extMethod("_bodhi-pi/session/delete", { sessionId: A })`; `listSessions` — A gone, B remains.
2. Run all 3 runtimes → green.
3. `just test`.
4. Commit: `bodhi-pi e2e: sessions.e2e.ts covers list/close/resume/delete`.

### Phase 3 — System prompt + context files

1. Write `system-prompt.e2e.ts` with one flow:
   - Harness with `systemPrompt: "Always reply in ALL CAPS."`; prompt "say hello"; assert response is upper-case.
   - Harness with `appendSystemPrompt: "End every response with the word DONE."`; assert "DONE" trailing.
   - `bodhiPiFixture: "context-files"` (new data folder containing `.bodhi-pi/AGENTS.md` with a distinctive instruction); prompt — assert response reflects the instruction.
2. Create `e2e/data/context-files/.bodhi-pi/AGENTS.md` if step c is included.
3. Run all 3 runtimes → green.
4. `just test`.
5. Commit: `bodhi-pi e2e: system-prompt.e2e.ts (custom systemPrompt, appendSystemPrompt, AGENTS.md walk)`.

### Phase 4 — Cancellation

1. **Verify faux-provider availability for e2e**: check whether `registerFauxProvider` is reachable from `e2e/helpers/`. If not, add a small e2e helper that wraps the unit-test faux into an extension, registered via a `bodhiPiFixture: "faux-delay"` data folder so it works under all 3 runtimes via the rich loader. (The extension's `registerProvider` schedules deliberate per-chunk delays.)
2. Write `cancel.e2e.ts` with two tests:
   - **Test A (all runtimes, real LLM)**: Send a "count from 1 to 100" prompt that streams ~5 seconds. Start `prompt()` (don't await). `setTimeout(() => clientConn.cancel({ sessionId }), 400)`. Await prompt. Assert `result.stopReason === "cancelled"`. Assert event sequence includes `agent_start` but no `agent_end` with `stopReason: "end_turn"`.
   - **Test B (all runtimes, faux provider)**: Configure the faux to delay 200 ms between chunks, total 10 chunks. Cancel after 300 ms (mid-stream). Assert `stopReason: "cancelled"` and partial `message_update` events visible in `harness.events`.
3. Run all 3 runtimes → green.
4. `just test`.
5. Commit: `bodhi-pi e2e: cancel.e2e.ts (real-LLM mid-stream + faux-delay deterministic)`.

### Phase 5 — Extension API expansion (`registerCommand` + tail of extension surfaces)

1. Create `e2e/data/register-command/.bodhi-pi/extensions/register-command.js`:
   - Single-file flat `.js` extension that calls `pi.registerCommand("ext-greet", { description: "...", expand: () => "Reply with the single word: hi" })`.
2. Add a 6th test to `extensions.e2e.ts`:
   - `bodhiPiFixture: "register-command"`; prompt `/ext-greet`; assert response contains "hi".
   - Optional: assert the slash command appears in `available_commands_update` notification.
3. *(Optional, decide during the phase)*: add a 7th fixture covering `appendEntry` or `sendMessage` if the implementation is straightforward.
4. Run all 3 runtimes → green.
5. `just test`.
6. Commit: `bodhi-pi e2e: extensions.e2e.ts adds register-command fixture (custom slash commands via ExtensionAPI)`.

### Phase 6 — Thinking level + token limit + consolidations

This phase bundles three small changes that all touch existing files.

1. **Thinking level**: add a test to `chat.e2e.ts` that:
   - Lists `configOptions` from `newSession`, asserts the `thinking` selector exists when the active model supports it (use Claude Haiku).
   - Calls `setSessionConfigOption({ configId: "thinking", value: "high" })`.
   - Sends a prompt; asserts `ThinkingChangeEntry` is in the session history (read via `_bodhi-pi/session/entries`).
2. **Token limit**: add a test to `chat.e2e.ts` that:
   - Uses `compaction.reserveTokens` (no — that's compaction) — actually use the model's `maxOutputTokens` config option if exposed, OR use a real-LLM prompt with a very short response budget. Decide during the phase based on what's exposed via ACP.
   - If neither is exposed cleanly, mark the test `test.skip` with a one-line note and a follow-up.
3. **Consolidate `fs.e2e.ts`**: merge the two tests into one Haiku flow: write file → read file → grep file. Three `expect.soft` steps.
4. **Consolidate `events.e2e.ts`**: merge the two tests into one gpt-4o-mini flow. Setup once, run text prompt + flushEvents + assert; then tool prompt + flushEvents + assert. Use `expect.soft` per step.
5. Run all 3 runtimes → green.
6. `just test`.
7. Commit: `bodhi-pi e2e: thinking + token limit assertions in chat.e2e.ts; consolidate fs.e2e.ts and events.e2e.ts into single flows`.

### Phase 7 — Final gate + cleanup

1. `npm run test:e2e` from `packages/bodhi-pi` → all green, 0 skipped (modulo the documented `test.skip` from phase 6).
2. `just test` (monorepo) — rerun flakes once; fix genuine failures only.
3. Sweep the touched files for dead imports / obvious comments. Update `e2e/CLAUDE.md` if the conventions section drifted.
4. Commit (if cleanup needed): `bodhi-pi e2e: housekeeping after coverage expansion`.

## Verification per phase

For each phase ≥ green gate:

```
cd packages/bodhi-pi
npm run test:e2e -- --project in-memory <new-file-or-changed-file>
npm run test:e2e -- --project cli       <same>
npm run test:e2e -- --project http      <same>
npm run test:e2e                              # full matrix, regression check
just test                                      # monorepo gate
```

Final headline (phase 7): `npm run test:e2e` reports something like `62 passed / 0 skipped` (or `61 passed / 1 skipped` if the token-limit test is parked).

## Notes / non-goals

- **No production-package changes**: every diff lives under `packages/bodhi-pi/e2e/` or its data fixtures. The agent core, adapters, and reference hosts (`bodhi-pi-cli` / `-http` / `-node` / `-browser` / `-web`) stay untouched.
- **No `auto-compaction` coverage** — per user decision; manual `/compact` already covered.
- **No custom-baseUrl provider e2e** — would require a mock HTTP server; defer.
- **No `concurrent session switching` test** — orthogonal to coverage; defer.
- Faux-provider use in e2e is unusual (the convention is real LLM); we use it ONLY for the deterministic cancel-mid-stream test because timing-based real-LLM cancels are flaky. Document this in the test header.
