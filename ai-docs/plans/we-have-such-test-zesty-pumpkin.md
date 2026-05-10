# E2E Cleanup: Remove Skip Gates, Fail Fast on Missing Env, Drop Inline Timeouts

## Context

The e2e suites across `bodhi-pi-cli`, `bodhi-pi-web`, and `bodhi-pi-ws-frontend` carry three patterns the user wants eliminated:

1. **Conditional skip gates on env vars** — 18 `test.skip(!process.env.OPENAI_API_KEY, ...)` calls across `bodhi-pi-ws-frontend/e2e/*.spec.ts`, plus a `skipCrossProvider` const + `test.skipIf(skipCrossProvider)` in `bodhi-pi-cli/e2e/chat.e2e.ts` gated on `ANTHROPIC_API_KEY`. These silently turn into green runs when keys are missing, masking real coverage gaps.
2. **No fail-fast validation** — `bodhi-pi-ws-frontend/playwright.config.ts` validates only `ANTHROPIC_API_KEY` (not `OPENAI_API_KEY`); `bodhi-pi-cli/e2e/global-setup.ts` validates only `OPENAI_API_KEY` (not `ANTHROPIC_API_KEY`); `bodhi-pi-web/playwright.config.ts` validates only `VITE_OPENAI_API_KEY` (not `VITE_ANTHROPIC_API_KEY`, even though `cross-provider.spec.ts` requires it).
3. **Inline timeout overrides** — `expect(...).toHaveAttribute(..., { timeout: N })` and `chat.waitForState(state, N)` calls scattered through the specs. Per-call timeouts are brittle: they hide the real timing budget, drift from spec to spec, and obscure when the global config needs tuning.

The intended outcome: every e2e run either has all required keys (OPENAI + ANTHROPIC, plus VITE_* mirrors for web) and runs every test, or it fails before any test executes. No "silently skipped" tests. All assertion timeouts come from one place per package — the `playwright.config.ts` — and tests do not override them.

## Decisions (from Q&A)

- `ANTHROPIC_API_KEY` becomes **required** (not optional) in `bodhi-pi-cli/e2e/global-setup.ts`. The cross-provider mid-session test always runs.
- Global `expect.timeout` is set to **30_000ms** in every Playwright config. **Risk noted:** `bodhi-pi-web` currently uses 60s/90s overrides for skill/tool-failure flows; if those flake at 30s, the fix is to raise the global, not re-introduce inline overrides.
- `bodhi-pi-ws-frontend` validation moves to a new **`e2e/global-setup.ts`** wired via `globalSetup` (not inline in `playwright.config.ts`).

## Files to Modify

### 1. Remove skip gates

#### `packages/bodhi-pi-ws-frontend/e2e/*.spec.ts` — delete every `test.skip` env gate

| File | Line(s) |
|---|---|
| `m2-prompt.spec.ts` | 4 |
| `m4-tool-call.spec.ts` | 4 |
| `m5-sessions.spec.ts` | 4 |
| `m7-commands.spec.ts` | 7, 38 |
| `m8-scripted-skill.spec.ts` | 7 |
| `m8-skills.spec.ts` | 7 |
| `m9-extensions.spec.ts` | 7 |
| `m10-fs-tools.spec.ts` | 6, 30, 54, 79 |
| `m10-workspace.spec.ts` | 7 |
| `m11-auto-resume.spec.ts` | 5, 34 |
| `m11-event-stream.spec.ts` | 23 |
| `m12-cancel.spec.ts` | 4 |

Each line is a stand-alone `test.skip(!process.env.OPENAI_API_KEY, "needs OPENAI_API_KEY");` — delete the line. Surrounding test bodies stay untouched.

#### `packages/bodhi-pi-cli/e2e/chat.e2e.ts`

- Delete line 55: `const skipCrossProvider = !ANTHROPIC_KEY;`
- Line 57: change `test.skipIf(skipCrossProvider)(...)` → `test(...)`. The test body and surrounding `describe` are unchanged.
- Line 8: change `const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";` → `const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!;` (it is now required upstream by `global-setup.ts`).

### 2. Add fail-fast env validation

#### `packages/bodhi-pi-cli/e2e/global-setup.ts` — extend existing setup

Current state validates only `OPENAI_API_KEY`. Add `ANTHROPIC_API_KEY`:

```ts
export function setup(): void {
  const required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for e2e: ${missing.join(", ")}. ` +
        `Set them in packages/bodhi-pi-cli/e2e/.env.test.`,
    );
  }
}
```

Already wired via `vitest.e2e.config.ts:30` (`globalSetup: ["./e2e/global-setup.ts"]`) — no config change.

#### `packages/bodhi-pi-ws-frontend/` — create `e2e/global-setup.ts` and wire it

New file `packages/bodhi-pi-ws-frontend/e2e/global-setup.ts`:

```ts
async function globalSetup() {
  const required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for ws-frontend e2e: ${missing.join(", ")}. ` +
        `Set them in packages/bodhi-pi-ws-server/.env or packages/bodhi-pi-ws-frontend/e2e/.env.test.`,
    );
  }
}

export default globalSetup;
```

Update `packages/bodhi-pi-ws-frontend/playwright.config.ts`:
- Remove the inline `if (!process.env.ANTHROPIC_API_KEY) throw ...` block (lines 13–18) — it moves into `global-setup.ts`.
- Keep the two `loadEnv(...)` calls at the top (Playwright's `globalSetup` runs after config evaluation, but the `loadEnv` calls happen at config-load time and populate `process.env` for the global setup function).
- Add `globalSetup: "./e2e/global-setup.ts"` to the `defineConfig({...})` block.
- Add `expect: { timeout: 30_000 }` to the `defineConfig({...})` block.

#### `packages/bodhi-pi-web/playwright.config.ts` — extend existing validation + add expect timeout

Current state validates only `VITE_OPENAI_API_KEY` (lines 10–14). Extend to also require `VITE_ANTHROPIC_API_KEY` (mandatory because `cross-provider.spec.ts` switches to `claude-haiku-4-5`, and per `bodhi-pi-web/CLAUDE.md`: "Anthropic registers as a switch target only when `VITE_ANTHROPIC_API_KEY` is set"):

```ts
const requiredEnv = ["VITE_OPENAI_API_KEY", "VITE_ANTHROPIC_API_KEY"] as const;
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `Missing required env vars for bodhi-pi-web e2e: ${missing.join(", ")}. ` +
      `Copy packages/bodhi-pi-cli/.env to packages/bodhi-pi-web/.env and re-prefix with VITE_.`,
  );
}
```

Also add `expect: { timeout: 30_000 }` to the `defineConfig({...})` block.

### 3. Remove inline timeout overrides

#### `packages/bodhi-pi-ws-frontend/e2e/pages/AppPage.ts:57-59`

Drop the `timeoutMs` parameter and the inline `{ timeout: ... }`:

```ts
async expectChatStatus(status: "idle" | "streaming") {
  await expect(this.status).toHaveAttribute("data-chat-status", status);
}
```

Audit all callers of `expectChatStatus` and remove any positional `timeoutMs` argument they pass.

#### `packages/bodhi-pi-ws-frontend/e2e/m11-auto-resume.spec.ts`

- Line 27: drop `, { timeout: 10_000 }` from `expect(app.status).toHaveAttribute(...)`.
- Line 73: drop `{ timeout: 10_000 }` from the surrounding expect call.

#### `packages/bodhi-pi-web/e2e/pages/ChatPage.ts:30-31`

Drop the `timeout` parameter:

```ts
async waitForState(state: TestState) {
  await expect(this.chatPage).toHaveAttribute("data-test-state", state);
}
```

#### `packages/bodhi-pi-web/e2e/*.spec.ts` — drop the second arg from `waitForState` calls

| File | Lines |
|---|---|
| `tool-failure.spec.ts` | 9, 19 |
| `model-switch.spec.ts` | 6, 19, 38 |
| `skills.spec.ts` | 15, 26, 48, 61, 73, 76 |
| `events.spec.ts` | 33, 48 |
| `cross-provider.spec.ts` | 9, 16, 28 |

Each call goes from `await chat.waitForState("idle", 60_000)` (or `90_000`) → `await chat.waitForState("idle")`.

### 4. Repo-wide lint guard (optional but recommended)

After the cleanup, the repo will have zero inline `{ timeout:` in `e2e/` directories. Consider adding a one-line CI grep guard so regressions are caught at PR time:

```sh
! grep -RnE "\{\s*timeout\s*:" packages/*/e2e/ 2>/dev/null
```

This is a single command in the relevant CI step (e.g., a `lint:e2e-timeouts` script in the root `package.json`). Skip if the user prefers to add it later as a follow-up.

## Out of Scope

- `webServer.timeout` values in `playwright.config.ts` files (30s/60s for dev-server boot) — these are infra startup budgets, not test/expect timeouts, and the user's request is about test-level overrides.
- `test.timeout` (currently 60_000 in ws-frontend, 120_000 in web) — these are the per-test caps, not assertion timeouts. Leave them; they wrap the new 30s `expect.timeout`.
- `bodhi-pi/e2e/` and `bodhi-pi-cli/e2e/*.e2e.ts` (other than `chat.e2e.ts`) — exploration confirmed no inline timeouts and no other env-skip gates exist.
- Tests in `bodhi-pi-web/e2e/scripted-skill.spec.ts`, `sessions.spec.ts`, `chat.spec.ts`, `extensions.spec.ts`, `fs-tools.spec.ts`, `model-persists.spec.ts`, `workspace.spec.ts` — exploration found they already use fixture defaults with no inline overrides.

## Verification

Run each suite **without** the relevant key first to confirm fail-fast behavior:

1. `cd packages/bodhi-pi-cli && unset ANTHROPIC_API_KEY && npm run test:e2e` → must fail before any test runs with the new error message naming `ANTHROPIC_API_KEY`.
2. `cd packages/bodhi-pi-ws-frontend && unset OPENAI_API_KEY && npx playwright test` → must fail in `globalSetup` with the new error.
3. `cd packages/bodhi-pi-web && unset VITE_ANTHROPIC_API_KEY && npx playwright test` → must fail at config load with the new error.

Then run each suite **with** all keys set and confirm:

4. `cd packages/bodhi-pi-cli && npm run test:e2e` → all e2e tests run (including the formerly-skipped cross-provider test) and pass.
5. `cd packages/bodhi-pi-ws-frontend && npx playwright test` → all 11 specs run (none skipped) and pass.
6. `cd packages/bodhi-pi-web && npx playwright test` → all 13 specs run and pass under the new 30s `expect.timeout`. **Watch closely:** `skills.spec.ts:61` and `tool-failure.spec.ts:19` previously had 90s budgets. If they flake, raise the global to 60s or 90s rather than re-introducing inline overrides.

Final guard:

7. `grep -RnE "test\.skip(If)?\(.*process\.env" packages/*/e2e/` → expect zero matches.
8. `grep -RnE "\{\s*timeout\s*:" packages/*/e2e/` → expect zero matches.
