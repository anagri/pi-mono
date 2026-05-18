# Kickoff: bodhi-pi test-app-http — configJson defaultModelId is being ignored at session boot

**Output**: a debugging plan written to `ai-docs/plans/YYYY-MM-DD-bodhi-pi-http-default-model-bug.md`. Read source first, batch `AskUserQuestion` calls for ambiguous decisions, get plan approval before any code edits. This is **bug-hunt** mode — the fix is one or two lines once the root cause is identified, but the cause is non-obvious. Don't pre-commit to a code change; the plan is a hypothesis tree + verification commands.

## Status going in

Three commits landed on `main` today (2026-05-18) that together rewire the http test-app's config flow:

1. `e4c7808c` — Vite proxy fix: added `/provision` + `/oauth/callback` to the proxy list; forced `127.0.0.1` (IPv4) targets to avoid `[::1]:3000` collisions. Setup form now reaches the server.
2. `(uncommitted but staged in working tree)` — wired `configJson → /provision → kvStore + settings.json`:
   - `test-apps/http/src/client/acp/adapter-http.ts` + `adapter-ws.ts` now parse `values.configRaw` and forward `apiKeys: Record<string, string>` + `defaultModelId?: string` in the `/provision` POST body.
   - `test-apps/http/src/host/provision.ts` accepts both, seeds each `apiKeys[provider]` into the user's kvStore as `auth/<provider>` in the canonical `{api_key: {value, secret: true}}` shape (matching what `_bodhi-pi/kv/set auth/...` writes), and writes `<userDir>/workspace/.bodhi-pi/settings.json` with `{defaultModelId}` if provided.
   - `e2e-ui/playwright.config.ts` no longer passes `--models openai:gpt-4o-mini,... --default-model gpt-4o-mini` to the spawned http server. All 4 runtimes are intended to be configured the same way: via the SetupForm's `configJson` field.

The intent is to match the browser/chrome-ext UX where `runtime/adapter.ts` already parses `values.configRaw` and applies `apiKeys` + `defaultModelId` to the in-process agent. Previously http/ws ignored `configJson` entirely (the fixtures.ts comment says "Split-host test-apps (http, ws) ignore it; in-process hosts (browser, chrome-ext) consume it.").

## The bug

`e2e-ui/shared/simple-chat.spec.ts` for `--project=http` fails. The test sends "Answer in one word: what day comes after Monday?" and asserts the assistant replies with "tuesday". It times out at `chat.waitForIdle()` with no assistant message.

The persisted session log shows the agent picked the WRONG model:

```jsonc
// users/<id>/workspace's sessions.db, session_entries table:
// message #1 (user): "Answer in one word: what day comes after Monday?"
// message #2 (assistant):
{
  "role": "assistant",
  "content": [],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-3-5-haiku-20241022",   // ← WRONG. Should be openai/gpt-4o-mini.
  "stopReason": "error",
  "errorMessage": "404 ... \"model: claude-3-5-haiku-20241022\""
}
```

`claude-3-5-haiku-20241022` is the FIRST anthropic model alphabetically in pi-ai's catalog, and anthropic is alphabetically earlier than openai in `getProviders()`. With both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` resolvable (env + per-user kvStore), `allModels()` returns `[...anthropicCatalog, ...openaiCatalog, ...]`. `models[0]?.id` is the retired anthropic id → 404.

But `pickDefaultModelIdOrNull(mergedFileSettings)` is supposed to prefer settings.json's `defaultModelId` BEFORE falling back to `models[0]`. Settings.json has `{"defaultModelId":"gpt-4o-mini"}` and `gpt-4o-mini` IS in the openai catalog. So pick should return `"gpt-4o-mini"`, not the first anthropic model.

## What's verified clean (don't re-verify)

- `provision.ts` writes `users/<id>/workspace/.bodhi-pi/settings.json` with `{"defaultModelId":"gpt-4o-mini"}` — confirmed on disk after a failed run.
- `provision.ts` writes `kv/<id>/auth%2Fopenai.json` with `{"api_key":{"value":"sk-proj-...","secret":true}}` — confirmed on disk.
- `provision.ts` writes `kv/<id>/auth%2Fanthropic.json` similarly — confirmed.
- Standalone probe: `loadProjectSettings(createNodeFilesystem({rootCwd: cwd}), cwd)` against the seeded user dir returns `{settings: {defaultModelId: "gpt-4o-mini"}, present: true}`.
- Standalone probe: `kvStore.get("auth/openai")` returns the correct api_key payload.
- `gpt-4o-mini` is present in pi-ai's openai catalog (`getModels("openai").find(m => m.id === "gpt-4o-mini")` is non-undefined).
- `claude-3-5-haiku-20241022` IS the first model returned by `getModels("anthropic")`.
- `npm run check` is green.

## Hypotheses to investigate

Numbered by where in the per-turn pipeline the failure could live. Each hypothesis includes a cheap test that either eliminates it or confirms it.

### H1 — `loadProjectArtifacts` doesn't actually read settings.json in the spawned-server context

Standalone probe works. But maybe inside the test-app-http server, the FS jail/cwd resolution differs. Or maybe a different `Filesystem` instance is used than the standalone probe assumed.

**Test**: add a one-line `console.log` to `src/sessions/session-bootstrap.ts:loadProjectArtifacts` printing `mergedFileSettings.defaultModelId` right before `buildSessionState` returns. Rebuild bodhi-pi/dist, re-run the test, inspect server stderr (Playwright captures it under `stderr: "pipe"` in `webServer` config — may need to enable a log path, or temporarily set `stderr: "inherit"`).

### H2 — `mergedFileSettings` is computed but the `defaultModelId` field is being stripped by `mergeSettings`

`mergeSettings(global, project)` might have a known-key allowlist or shape constraint that drops unknown fields. Verify by reading `src/settings/settings-merge.ts` and confirming `defaultModelId` is preserved in the merged output.

### H3 — `ModelRegistry.pickDefaultModelIdOrNull` is bypassed for the per-turn rebuild path

`buildSessionState` (`src/sessions/session-bootstrap.ts`) calls `pickDefaultModelIdOrNull`. `rehydrateSession` does NOT — it uses `ctx.currentModelId ?? deps.config.defaultModelId ?? null` directly. Is the test exercising `newSession` (which uses pick) or `rehydrateSession` (which does not)?

**Test**: in the AppShell flow, `ensureSession` calls `dispatchAcp("session/new")` → `agent.newSession` → `buildSessionState` (uses pick). Should be pick path. Confirm by tracing the wire frames — was there an `initialize` then `session/new` then `session/prompt`? Or did something issue `session/load` instead?

### H4 — bodhi-pi `dist/` is stale and the running server is using old code

I rebuilt bodhi-pi/dist earlier today after sub-agents v1, but my session-bootstrap changes (threading `subagentService` through `BootstrapDeps`) might not have rebuilt cleanly OR the http test-app's `npm run build` doesn't trigger a bodhi-pi rebuild.

**Test**: `grep "pickDefaultModelIdOrNull" packages/bodhi-pi/dist/models/registry.js` should show the function. Also check `packages/bodhi-pi/dist/sessions/session-bootstrap.js` for the new `subagentService` param. If stale, rebuild bodhi-pi explicitly before re-running.

### H5 — `models[0]` returns first anthropic model AND `pickDefaultModelIdOrNull`'s `models.find(...)` is racy / wrong

Re-read `src/models/registry.ts:163-170`. The logic:

```ts
if (this.defaultModelId && models.find(m => m.id === this.defaultModelId)) return this.defaultModelId;
const fromSettings = resolveSettingsDefaultModelId(merged);
if (fromSettings && models.find(m => m.id === fromSettings)) return fromSettings;
return models[0]?.id ?? null;
```

If `models` doesn't contain `gpt-4o-mini` (maybe pi-ai's openai catalog isn't loaded — getApiKey returns undefined for "openai" for some reason?), the function falls through to `models[0]?.id`. With anthropic auth available, that's the first anthropic model.

**Test**: instrument `ModelRegistry.allModels()` to print every model id it returns + every provider's apiKey-resolve result. Re-run, check stderr.

### H6 — Per-turn rebuild uses a different cwd or filesystem than `loadProjectSettings` expects

`wire-agent-shared.ts:97-103` computes `cwd = resolveUserWorkspace({dataDir, userId})`. The proxy at line 138 sets `cwd` on `newSession`. But is this same cwd passed to `loadProjectArtifacts`?

Read `wire-agent-shared.ts:113-149`. The agent's `BodhiPiConfig.filesystem = createNodeFilesystem({rootCwd: cwd})` — so the filesystem IS jailed to cwd. `agent.newSession({cwd: <same value>})` → `buildSessionState(... cwd: <same value>)` → `loadProjectArtifacts(config, cwd, sessionId, subagentService)` reads settings from that cwd. Should work.

Worth manually tracing once more in the source to be 100% sure no path mismatch.

### H7 — Build artifacts the server actually uses are different from what `tsc` recompiles

`test-apps/http/dist/index.js` is the entry. It imports `@bodhiapp/bodhi-pi-test-app-node-adapters` → `dist/` of that package. And `@bodhiapp/bodhi-pi` → `dist/` of bodhi-pi. If ANY of these `dist/` are stale, the spawned server runs old code.

**Test**: nuke ALL three `dist/`s, rebuild all from scratch, re-run:
```sh
rm -rf packages/bodhi-pi/dist packages/bodhi-pi/test-apps/node-adapters/dist packages/bodhi-pi/test-apps/http/dist
npm --workspace @bodhiapp/bodhi-pi run build
npm --workspace @bodhiapp/bodhi-pi-test-app-utils run build
npm --workspace @bodhiapp/bodhi-pi-test-app-node-adapters run build
npm --workspace @bodhiapp/bodhi-pi-test-app-http run build
cd packages/bodhi-pi/e2e-ui
npx playwright test --project=http shared/simple-chat.spec.ts
```

## Process

This is debugging — the iteration loop is:

1. Pick the cheapest hypothesis from above (H4 + H7 are zero-thought-cost — just clean rebuild).
2. If still broken, add a `console.log("[bodhi-pi default-model]", ...)` at the suspected layer (H1, H5).
3. Re-run the Playwright test for `--project=http` ONLY (faster than all 4):
   ```sh
   cd packages/bodhi-pi/e2e-ui && npx playwright test --project=http shared/simple-chat.spec.ts
   ```
4. Inspect server stderr (may need to temporarily flip Playwright's `webServer.stderr` from `"pipe"` to `"inherit"` to see it inline).
5. Eliminate / confirm; loop.

Once the root cause is identified, the fix is likely:
- A one-line bug fix in `ModelRegistry.pickDefaultModelIdOrNull` or `loadProjectArtifacts`, OR
- A one-line fix in `provision.ts` (e.g., write to a different settings location), OR
- A build/wiring fix (rebuild discipline).

Don't pre-commit to a fix in the plan — the plan IS the diagnostic tree + verification commands. The fix goes in a separate session after the cause is known.

## Acceptance criteria

The plan is "done" when:

1. The exact line(s) of code where the default-model-vs-models[0] divergence happens is identified, with a citation.
2. The fix is described in one paragraph (not implemented).
3. The Playwright test `simple-chat.spec.ts --project=http` is expected to pass after the fix, AND `--project=ws/browser/chrome-ext` are NOT regressed.
4. Verification commands are listed for the fix-then-test cycle.

## Plan structure (mandatory sections)

1. **Goal restatement** — the bug, the hypotheses, the cheapest verification per.
2. **Code citations** — file:line for each hypothesis. Re-read source; don't trust memory.
3. **Verification commands** — exact `npm run` / `npx` invocations per hypothesis.
4. **Hypothesis ranking** — most-likely first based on what you find in the source read.
5. **Proposed fix sketch** — one paragraph, NOT code, NOT implemented in this session.
6. **Out of scope** — anything beyond the default-model selection bug. Don't refactor ModelRegistry, don't reshape provision, don't touch sub-agents.

## Anti-patterns to avoid

- Don't reshape `provision.ts` or move where settings.json is written. The seeded data is verified clean on disk. The bug is on the READ side.
- Don't add `--default-model` back to `playwright.config.ts` as a "workaround". That would mask the bug and undo the config-via-form unification the user explicitly asked for.
- Don't propose a registry-wide refactor. The pickDefaultModelIdOrNull contract is clear and (per standalone probe) correct.
- Don't write `defaultModelId` to a SECOND location (e.g., per-user kvStore) — there's no evidence settings.json doesn't work in principle; only that it's not being honored in the spawned-server flow.
- Don't run the full Playwright suite during debugging. Stick to `--project=http shared/simple-chat.spec.ts` — fastest signal.

## References

- Recent commits:
  - `e4c7808c` Vite proxy fix
  - `(uncommitted)` configJson → /provision wiring (4 files changed: adapter-http.ts, adapter-ws.ts, provision.ts, playwright.config.ts)
- Relevant source:
  - `packages/bodhi-pi/src/models/registry.ts:163-170` — `pickDefaultModelIdOrNull`
  - `packages/bodhi-pi/src/sessions/session-bootstrap.ts:58-100` — `loadProjectArtifacts`
  - `packages/bodhi-pi/src/sessions/session-bootstrap.ts:240-242` — `buildSessionState` model resolution
  - `packages/bodhi-pi/src/settings/settings.ts:50-58` — `resolveSettingsDefaultModelId`
  - `packages/bodhi-pi/test-apps/http/src/host/wire-agent-shared.ts:97-149` — per-turn agent rebuild + cwd resolution
  - `packages/bodhi-pi/test-apps/http/src/host/provision.ts` — the seeding logic (just landed)
  - `packages/bodhi-pi/test-apps/browser/src/client/runtime/adapter.ts:39-90` — the working browser path that consumes configJson (reference for what http aims to mirror)
- Spec for the per-turn-rebuild story: `ai-docs/specs/bodhi-pi/hosts.md` § http
- Fixture providing the configJson the tests use: `packages/bodhi-pi/e2e-ui/fixtures.ts:62-73`

## When done

Print: the plan path, the most-likely-root-cause hypothesis, and the single one-line fix that would address it (described in prose, not code). Do not implement the fix in this session — the diagnostic plan IS the deliverable. The fix runs in a separate session with `superpowers:executing-plans`.
