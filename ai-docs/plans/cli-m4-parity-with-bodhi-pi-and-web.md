# bodhi-pi-cli ↔ web parity push

## Context

The May-09 multi-package review (`ai-docs/reviews/2026-05-09-index.md`) surfaced one dominant theme: `bodhi-pi-cli` lags both `bodhi-pi` (the agent core) and `bodhi-pi-web` on user-visible features, even though every host-injected interface they need (filesystem, sessions, scripts, extensions, lifecycle events) already lives in `@bodhiapp/bodhi-pi-node`. Two specific symptoms motivate this plan:

1. **Production binary is feature-dark.** `packages/bodhi-pi-cli/src/cli.ts:9-19` constructs the agent without calling `createNodeExtensionLoader` and without forwarding `eventHandlers`, so the shipped REPL cannot use either capability — even though `createCliAgent` accepts both options and the e2e harness exercises them. The web counterpart at `packages/bodhi-pi-web/src/agent/worker.ts:81,91` auto-discovers extensions and wires event handlers from the same workspace conventions.

2. **Test matrix is asymmetric.** `bodhi-pi/e2e/` has 7 specs and `bodhi-pi-web/e2e/` has 14; `bodhi-pi-cli/e2e/` has 6. The CLI is missing real-LLM e2e for slash commands, markdown skills, scripted skills, multi-turn chat, cross-provider switch, model persistence, tool-failure rendering, and tool-call replay on session load. Per `packages/bodhi-pi-cli/CLAUDE.md` "Drift between the two is a regression risk — both must pass before a feature is done", every web spec that is portable must have a CLI mirror.

The intended outcome: `bodhi-pi-cli` ships a binary that is feature-equivalent to `bodhi-pi-web` (modulo browser-only UX such as the FSA picker), and the e2e suite proves every agent-contract surface end-to-end through real Node adapters against `gpt-4o-mini` (and `claude-haiku-4-5` for the cross-provider case).

## Scope decisions (locked)

- **Wire production cli.ts AND add e2e specs.** Both halves of parity land in this plan.
- **UI parity:** add tool-failure rendering coverage and tool-call replay coverage. Skip streaming/cancel UI (gpt-4o-mini finishes too fast to reliably catch streaming state per `bodhi-pi-web/CLAUDE.md`).
- **Slash commands:** add `/close` and `/delete` to the CLI; keep `/quit`. Match the canonical web set in `packages/bodhi-pi-web/src/ui/commands.ts`.
- **Extensions stay JavaScript-only.** Node loader keeps `.js`/`.mjs`/`.cjs` only — `.ts`/`.tsx` + `jiti` removal is out of scope here (covered by `ai-docs/reviews/2026-05-09-bodhi-pi-cli-node.md` Batch A.1, fix in a separate commit).
- **Workspace mount/unmount UX is browser-only.** No CLI port for `bodhi-pi-web/e2e/workspace.spec.ts`.

## Files to modify or create

### Production binary wiring

| Path | Change |
|---|---|
| `packages/bodhi-pi-cli/src/cli.ts` | Call `createNodeExtensionLoader({ cwd: process.cwd() })` unless `--no-extensions` flag set; forward result as `extensionFactories`. Forward optional `eventHandlers` from `cfg`. |
| `packages/bodhi-pi-cli/src/config.ts` | Parse new `--no-extensions` flag and new `--debug-events` flag (env `BODHI_DEBUG_EVENTS=1`). Build a default `eventHandlers` map that prints one-line stderr diagnostics per event type when `--debug-events` is on; otherwise leave undefined. |
| `packages/bodhi-pi-cli/src/repl/commands.ts` | Add `/close` (call `clientConn.closeSession({sessionId})` then mark a closed-state flag in `ReplState` so subsequent prompts are blocked with the same message web uses). Add `/delete <id>` (call `clientConn.extMethod("_bodhi-pi/session/delete", {sessionId: id})`; if id matches active session, kick off `/new` after). Update `/help` listing. |
| `packages/bodhi-pi-cli/src/repl/repl.ts` | Block prompt forwarding when `state.closed === true`; print the same hint web uses ("session is closed. Use /new to start a fresh one or /resume <id>."). |

### Renderer

| Path | Change |
|---|---|
| `packages/bodhi-pi-cli/src/repl/render.ts` | No new rendering logic required: `tool_call_update.status === "failed"` already prints the red `✗` line, and replayed `tool_call`/`tool_call_update` from `loadSession` already flows through the same handler. New e2e proves both code paths. Add a small comment documenting that the same path serves live + replayed updates so future refactors don't gate on source. |

### Test helpers

| Path | Change |
|---|---|
| `packages/bodhi-pi-cli/test/helpers/seed-workspace.ts` (new) | `seedWorkspace(tmpDir, { commands?, skills?, extensions? })` writes `.bodhi-pi/{commands,skills,extensions}/` files into a tmpdir for e2e use. Mirror the templates exposed in `packages/bodhi-pi-web/e2e/helpers/seed.ts` and the example workspace at `packages/bodhi-pi-web/e2e/examples/`. |
| `packages/bodhi-pi-cli/test/helpers/event-recorder.ts` (new) | Single `recorder()` factory registering all 19 lifecycle event types and returning `{ log, handlers }`. Reuse from cli e2e — same shape as the new `bodhi-pi/test/helpers/event-recorder.ts` slated by core review C.1; if that helper lands first, import from `@bodhiapp/bodhi-pi/test/helpers` instead. |
| `packages/bodhi-pi-cli/test/helpers/cli-harness.ts` | Already supports `eventHandlers`/`extensionFactories` — no change. |

### New e2e specs (under `packages/bodhi-pi-cli/e2e/`)

Each is a Node mirror of the bodhi-pi or bodhi-pi-web spec named in parens. All use `createCliTestHarness`, real `gpt-4o-mini`, real Node adapters (tmpdir + SQLite + Node ScriptExecutor + Node extension loader), and assert side-effects + stable substrings.

| New file | Source spec(s) | What it proves |
|---|---|---|
| `commands.e2e.ts` | `bodhi-pi/e2e/commands.e2e.ts` + `bodhi-pi-web/e2e/commands.spec.ts` | `.bodhi-pi/commands/*.md` discovered, `/<cmd>` expands `$1`, available_commands_update re-fires after `loadSession`. |
| `skills.e2e.ts` | `bodhi-pi/e2e/skills.e2e.ts` + `bodhi-pi-web/e2e/skills.spec.ts` | Markdown skills discovered, `/skill:say-hello` expands skill body into the prompt; `disable-model-invocation: true` skill still callable via slash; unknown `/skill:` falls through to the LLM. |
| `scripted-skill.e2e.ts` | `bodhi-pi/e2e/scripted-skill.e2e.ts` + `bodhi-pi-web/e2e/scripted-skill.spec.ts` | `/skill:days-since-birthday <date>` invokes `run_script` against `createNodeScriptExecutor`; integer reaches the assistant. |
| `chat.e2e.ts` | `bodhi-pi/e2e/chat.e2e.ts` + `bodhi-pi-web/e2e/cross-provider.spec.ts` | Multi-turn context retention ("favourite number is 42" → recall) + Anthropic↔OpenAI mid-session switch via `setSessionConfigOption`. Skips Anthropic-half if `ANTHROPIC_API_KEY` absent. (Keeps existing `repl.e2e.ts` as the bare smoke spec.) |
| `model-switch.e2e.ts` | `bodhi-pi-web/e2e/model-switch.spec.ts` | `/model` with no args lists models, `/model <id>` switches and the next turn routes to the new provider, `/model unknown` errors cleanly. |
| `model-persists.e2e.ts` | `bodhi-pi-web/e2e/model-persists.spec.ts` | After `/model gpt-4o`, `/new`, `/resume <prior-id>`, the resumed session reports `gpt-4o` via `configOptions[0].currentValue`. |
| `tool-failure.e2e.ts` | `bodhi-pi-web/e2e/tool-failure.spec.ts` | LLM asked to `read` a missing file — assert `tool_call_update.status === "failed"` notification AND that the renderer's red `✗` line lands in stdout (capture via `process.stdout.write` mock or by snapshotting harness updates). |
| `tool-replay.e2e.ts` | `bodhi-pi-web/e2e/tool-replay.spec.ts` | After a turn that writes a file, capture `sessionId`, run `/new`, `/resume <id>`, assert the historical `write` tool_call replays as a completed `tool_call`/`tool_call_update` notification (no re-execution, status comes from persisted entry). |

Total new e2e files: **8**. Net surface change: REPL gains two slash commands, CLI binary auto-discovers extensions and accepts `--debug-events`/`--no-extensions`.

## Surfaces explicitly NOT ported

- `bodhi-pi-web/e2e/workspace.spec.ts` — FSA picker mount + unmount + status-bar pill is browser UX only. CLI has `--cwd` (or `process.cwd()`).
- `bodhi-pi-web/e2e/events.spec.ts` `window.__bodhiPiEventLog` injection — the CLI subscribes to events directly via `eventHandlers`, no test-only DOM bridge needed. The CLI's existing `events.e2e.ts` is the equivalent.
- Streaming/cancel UI button (`Composer.tsx` send→stop morph) — gpt-4o-mini finishes too fast for the assertion to be stable; web also documents this as "no e2e for cancel button" (`packages/bodhi-pi-web/CLAUDE.md` Test conventions). The agent-side `cancel` is already covered in `bodhi-pi/test/chat.test.ts:457` against a slow faux provider.
- `.ts`/`.tsx` extension support in the Node loader — out of scope; tracked in cli-node review Batch A.1.

## Reuse map (functions/utilities to lean on)

- `createNodeExtensionLoader` at `packages/bodhi-pi-node/src/extensions/node-extension-loader.ts:31` — already does `.bodhi-pi/extensions/` discovery and per-extension error isolation. Drop in.
- `createCliTestHarness` at `packages/bodhi-pi-cli/test/helpers/cli-harness.ts:26` — already accepts `eventHandlers`/`extensionFactories`. Reuse for every new spec.
- `chunkedAgentText`, `toolCallUpdates`, `toolUpdateText` at `packages/bodhi-pi-cli/test/helpers/{notifications,tool-call-asserts}.ts` — assertion building blocks, reuse across all 8 new specs.
- `EXT_DELETE_SESSION` constant at `packages/bodhi-pi/src/acp/constants.ts` — use this string for the `/delete` slash-command's `extMethod` call so the wire literal is not duplicated.
- Web seed templates inlined in `packages/bodhi-pi-web/e2e/{skills,commands,extensions}.spec.ts` — copy verbatim into the new `seed-workspace.ts` so the two reference hosts seed identical workspaces. (Browser-web review D.1 also wants those templates centralized; coordinate names so both hosts share one source-of-truth file location if/when the helper graduates to a shared location.)

## Verification

End-to-end the user can validate:

1. **Production binary smoke (extensions auto-loaded):**
   - In a tmpdir, create `.bodhi-pi/extensions/pirate.js` (copy from `packages/bodhi-pi-web/e2e/examples/.bodhi-pi/extensions/pirate.js`).
   - Run `bodhi-pi-cli` from that tmpdir; ask `> hi` — assistant should reply with pirate-style language.
   - Re-run with `--no-extensions`; reply should be vanilla.
   - Re-run with `--debug-events`; stderr should print one line per event type during the turn.

2. **Slash commands:**
   - `/help` lists `/close` and `/delete` alongside the existing set.
   - `/close` then `>` should print the closed-session hint; `/new` recovers; `/delete <id>` removes the session from the next `/sessions` listing.

3. **Test suites green:**
   - `pnpm --filter @bodhiapp/bodhi-pi-cli test` (vitest unit/integration via faux providers).
   - `pnpm --filter @bodhiapp/bodhi-pi-cli test:e2e` (real LLM, requires `OPENAI_API_KEY` and optionally `ANTHROPIC_API_KEY` in `packages/bodhi-pi-cli/.env.test`; the cross-provider half of `chat.e2e.ts` skips when Anthropic key is absent).
   - All 8 new e2e files pass; the 6 existing pass unchanged.

4. **Cross-package no-regression:**
   - `pnpm --filter @bodhiapp/bodhi-pi test` and `:test:e2e` still pass — this plan touches no core code.
   - `pnpm --filter @bodhiapp/bodhi-pi-node test` still passes — adapter unchanged.

## Suggested commit ordering

Each commit ships independently and leaves the suite green:

1. **Slash commands.** Add `/close` and `/delete`; update `/help`; thread closed-state guard through `repl.ts` and `commands.ts`. No new e2e yet — covered by an integration test in `test/agent.test.ts` driving the existing harness.
2. **Production wiring.** `cli.ts` calls `createNodeExtensionLoader`; `config.ts` parses `--no-extensions` and `--debug-events`. Manual smoke per Verification §1.
3. **Test helpers.** `seed-workspace.ts` and `event-recorder.ts` — pure additions, no specs depending yet.
4. **Commands + skills + scripted-skill e2e** (`commands.e2e.ts`, `skills.e2e.ts`, `scripted-skill.e2e.ts`) — three Node mirrors of `bodhi-pi/e2e/` siblings.
5. **Multi-turn + cross-provider chat e2e** (`chat.e2e.ts`).
6. **Model command e2e pair** (`model-switch.e2e.ts`, `model-persists.e2e.ts`).
7. **Renderer-coverage e2e pair** (`tool-failure.e2e.ts`, `tool-replay.e2e.ts`).

After step 7 lands, update `packages/bodhi-pi-cli/CLAUDE.md` "Architecture pillars" to remove the implicit caveat that extensions/events are test-only, and update `ai-docs/milestones.md` with a `cli-parity` entry.
