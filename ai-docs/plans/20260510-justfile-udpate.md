# Justfile: full bodhi-pi build + test sequence

## Context

The current `just test` recipe only covers `@bodhiapp/bodhi-pi`, `bodhi-pi-node`, and `bodhi-pi-cli`. Four other workspaces under `packages/bodhi-pi*` (`bodhi-pi-browser`, `bodhi-pi-web`, `bodhi-pi-ws-server`, `bodhi-pi-ws-frontend`) have build and/or test scripts but are not exercised by `just test`. We want a single recipe that builds and tests every `bodhi-pi*` workspace in dependency order, running whichever of `test` / `test:e2e` is present per package and skipping ones that aren't.

## Inventory (what each workspace exposes)

Verified from each `package.json`:

| Workspace | `build` | `test` (vitest) | `test:e2e` |
|---|---|---|---|
| `@mariozechner/pi-ai` (dep) | yes | — | — |
| `@mariozechner/pi-agent-core` (dep) | yes | — | — |
| `@bodhiapp/bodhi-pi` | yes | yes | yes (vitest) |
| `@bodhiapp/bodhi-pi-node` | yes | yes | — |
| `@bodhiapp/bodhi-pi-browser` | yes | yes | — |
| `@bodhiapp/bodhi-pi-cli` | yes | yes | yes (vitest) |
| `@bodhiapp/bodhi-pi-web` | yes | — | yes (playwright) |
| `@bodhiapp/bodhi-pi-ws-server` | yes | yes | — |
| `@bodhiapp/bodhi-pi-ws-frontend` | yes | — | yes (playwright) |

No package exposes split `test:unit` / `test:integration` — `test` already runs both via vitest config.

## Dependency order

Derived from `dependencies` / `devDependencies`:

1. `@mariozechner/pi-ai` — leaf dep
2. `@mariozechner/pi-agent-core` — depends on `pi-ai`
3. `@bodhiapp/bodhi-pi` — depends on `pi-ai`, `pi-agent-core`
4. `@bodhiapp/bodhi-pi-node` — depends on `bodhi-pi`
5. `@bodhiapp/bodhi-pi-browser` — depends on `bodhi-pi`
6. `@bodhiapp/bodhi-pi-cli` — depends on `bodhi-pi`, `bodhi-pi-node`
7. `@bodhiapp/bodhi-pi-web` — depends on `bodhi-pi`, `bodhi-pi-browser`
8. `@bodhiapp/bodhi-pi-ws-server` — depends on `bodhi-pi`, `bodhi-pi-node`
9. `@bodhiapp/bodhi-pi-ws-frontend` — no internal deps; placed last alongside its server pair

## Decisions (from user)

- Single `test` recipe — no per-package or per-phase split.
- Always build before test (keep current behavior; safe over fast).
- Playwright e2e (`bodhi-pi-web`, `bodhi-pi-ws-frontend`) is included in `just test`; assumed self-contained (Playwright config handles its own server/mocks).
- Where a package lacks `test` or `test:e2e`, just skip that step — don't fail.

## Plan

Edit `/Users/amir36/Documents/workspace/src/github.com/anagri/pi-mono/justfile` — replace the body of the existing `test:` recipe with the full ordered sequence below. Keep the existing `default` and `setup` recipes untouched.

For each workspace, run only the steps it exposes:

```
test:
    # deps (build only)
    @echo "▶ @mariozechner/pi-ai — build (dep)"
    npm --workspace @mariozechner/pi-ai run build
    @echo "▶ @mariozechner/pi-agent-core — build (dep)"
    npm --workspace @mariozechner/pi-agent-core run build

    # bodhi-pi (build + test + test:e2e)
    @echo "▶ @bodhiapp/bodhi-pi — build"
    npm --workspace @bodhiapp/bodhi-pi run build
    @echo "▶ @bodhiapp/bodhi-pi — test"
    npm --workspace @bodhiapp/bodhi-pi run test
    @echo "▶ @bodhiapp/bodhi-pi — test:e2e"
    npm --workspace @bodhiapp/bodhi-pi run test:e2e

    # bodhi-pi-node (build + test; no e2e)
    @echo "▶ @bodhiapp/bodhi-pi-node — build"
    npm --workspace @bodhiapp/bodhi-pi-node run build
    @echo "▶ @bodhiapp/bodhi-pi-node — test"
    npm --workspace @bodhiapp/bodhi-pi-node run test

    # bodhi-pi-browser (build + test; no e2e)
    @echo "▶ @bodhiapp/bodhi-pi-browser — build"
    npm --workspace @bodhiapp/bodhi-pi-browser run build
    @echo "▶ @bodhiapp/bodhi-pi-browser — test"
    npm --workspace @bodhiapp/bodhi-pi-browser run test

    # bodhi-pi-cli (build + test + test:e2e)
    @echo "▶ @bodhiapp/bodhi-pi-cli — build"
    npm --workspace @bodhiapp/bodhi-pi-cli run build
    @echo "▶ @bodhiapp/bodhi-pi-cli — test"
    npm --workspace @bodhiapp/bodhi-pi-cli run test
    @echo "▶ @bodhiapp/bodhi-pi-cli — test:e2e"
    npm --workspace @bodhiapp/bodhi-pi-cli run test:e2e

    # bodhi-pi-web (build + playwright e2e; no vitest test)
    @echo "▶ @bodhiapp/bodhi-pi-web — build"
    npm --workspace @bodhiapp/bodhi-pi-web run build
    @echo "▶ @bodhiapp/bodhi-pi-web — test:e2e (playwright)"
    npm --workspace @bodhiapp/bodhi-pi-web run test:e2e

    # bodhi-pi-ws-server (build + test; no e2e)
    @echo "▶ @bodhiapp/bodhi-pi-ws-server — build"
    npm --workspace @bodhiapp/bodhi-pi-ws-server run build
    @echo "▶ @bodhiapp/bodhi-pi-ws-server — test"
    npm --workspace @bodhiapp/bodhi-pi-ws-server run test

    # bodhi-pi-ws-frontend (build + playwright e2e; no vitest test)
    @echo "▶ @bodhiapp/bodhi-pi-ws-frontend — build"
    npm --workspace @bodhiapp/bodhi-pi-ws-frontend run build
    @echo "▶ @bodhiapp/bodhi-pi-ws-frontend — test:e2e (playwright)"
    npm --workspace @bodhiapp/bodhi-pi-ws-frontend run test:e2e
```

Notes:
- Workspace name for `bodhi-pi-ws-frontend` is `@bodhiapp/bodhi-pi-ws-frontend` (verify the exact `name` field when editing — the inventory showed it without the scope; will reconfirm at edit time and use whatever the `package.json` declares).
- No conditional skipping logic in the recipe — each step is explicit, so missing scripts are simply absent rather than guarded.

## Critical files

- `justfile` (root) — only file modified.
- Read-only references: `packages/bodhi-pi*/package.json` (script names), `packages/bodhi-pi-web/playwright.config.ts`, `packages/bodhi-pi-ws-frontend/playwright.config.ts` (confirm self-contained).

## Verification

1. From repo root: `just test` — full sequence runs to completion with no "missing script" errors.
2. Spot-check by running a single step, e.g. `npm --workspace @bodhiapp/bodhi-pi-browser run test`, and confirm it matches what the recipe invokes.
3. If Playwright browsers are missing, the web/ws-frontend e2e steps will fail loudly — that's the expected signal to run `npx playwright install` (out of scope for this recipe).
