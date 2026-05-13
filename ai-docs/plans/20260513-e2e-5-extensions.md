# Enable `e2e/shared/extensions.e2e.ts` across all three runtimes

## Context

`packages/bodhi-pi/e2e/shared/extensions.e2e.ts` is guarded with `test.runIf(isRuntime("in-memory"))`. The five tests pass JS `ExtensionFactory` closures via `createE2EHarness({ extensionFactories: [...] })`, and closures can't cross the cli stdio or http boundaries.

Lifting the guard requires extensions to manifest as **real files** the agent loads at boot, identical across runtimes. The cli and http hosts already walk `<cwd>/.bodhi-pi/extensions/*.{js,mjs,cjs}` via `createNodeExtensionLoader`. What's missing is (a) the harness-side machinery to emit per-test fixture files into the right place per runtime, and (b) — per the user's direction — a richer Node-side extension loader that supports full Node packages (`package.json` + TS sources via jiti), alongside the existing flat-`.js` path. The agent itself stays oblivious: it receives a pre-resolved `RegisteredExtension[]` from whichever loader the host chose, exactly like `Filesystem` / `ScriptExecutor` / `SessionStore` injection today.

After this and the (already-landed) events work, `npm run test:e2e` reports **55 passed / 0 skipped**.

User-confirmed decisions:

1. **Per-test data folder**: `packages/bodhi-pi/e2e/data/<test-slug>/.bodhi-pi/...` — one snapshot per test.
2. **Constructor option**, not a method: `await createE2EHarness({ ..., bodhiPiFixture: "<test-slug>" })`.
3. **Inline JSON Schema literal** for `dynamic-tools` (no TypeBox import at runtime).
4. **Adopt the rich Node-package extension mode now** — but as a *host-injected loader*. `bodhi-pi/src` keeps its current contract (`extensionFactories: RegisteredExtension[]`). The new rich loader lives in `e2e/helpers/extension-loaders/` and is consumed by the test-app-cli, test-app-http, and the in-memory branch of the harness. Production `bodhi-pi-cli` / `bodhi-pi-http` / browser hosts keep their existing single-file loaders.
5. **Persist to real disk for all runtimes** — even in-memory writes the substituted fixture content to a per-test tmpdir for inspectability; in-memory loads from that real disk path.

## End state

- `packages/bodhi-pi/e2e/shared/extensions.e2e.ts` has no `runIf` guard. All 5 tests run under `|in-memory|`, `|cli|`, `|http|`.
- `npm run test:e2e` reports `55 passed / 0 skipped`.
- `just test` green.
- `bodhi-pi/src/` and `bodhi-pi-{cli,http,web,browser,node}` are **untouched** (the rich loader is e2e-only for now; promote later if a real extension demands it).

## Critical files

### Reads / models

- `packages/coding-agent/src/core/extensions/loader.ts` — jiti-based rich loader pattern (manifest, virtual modules, alias mapping). Mirror its shape, not its scale.
- `packages/bodhi-pi-node/src/extensions/node-extension-loader.ts` — flat-`.js` loader, "JS-only by charter" comment. Stays canonical for production.
- `packages/bodhi-pi-browser/src/extensions/browser-extension-loader.ts` — flat-`.js` data-URL loader, browser-only. Stays canonical.
- `packages/bodhi-pi/test/helpers/extension-fixtures.ts` — the 5 TS fixtures being ported.
- `packages/bodhi-pi/e2e/shared/commands.e2e.ts` + `scripted-skill.e2e.ts` — established `harness.filesystem.writeTextFile` pattern for seeding `.bodhi-pi/` artifacts uniformly across runtimes.

### Modified (across all phases)

- `packages/bodhi-pi/e2e/helpers/harness.ts` — add `bodhiPiFixture?: string` to `E2EHarnessOptions`; per-runtime seeding (in-memory: dynamic-import from data folder; cli/http: symlink into `harness.cwd`; cli: drop `--no-extensions` when fixture is set). Phase 4 also retires the `extensionFactories` option.
- `packages/bodhi-pi/e2e/shared/extensions.e2e.ts` — phase 1: 4 tests switch to `bodhiPiFixture`, drop `runIf`. Phase 4: `register-provider` switches too. Phase 5: drop the final `runIf(in-memory)` from `register-provider`.
- `packages/bodhi-pi/e2e/test-app-cli/src/cli.ts` — phase 5 only: swap `createNodeExtensionLoader` for the rich loader.
- `packages/bodhi-pi/e2e/test-app-http/src/server/agent/wire-agent.ts` — phase 5 only: same swap.
- `packages/bodhi-pi/test/helpers/extension-fixtures.ts` — phase 4: remove now-unused exports (`makeRegisterProviderFactory`, etc.).

### New (across all phases)

- `packages/bodhi-pi/e2e/helpers/seed-bodhi-pi.ts` — phase 1: `loadFixtureFactoriesFromSource(fixtureName): Promise<RegisteredExtension[]>` (flat-`.js`-only). Phase 4: re-route through the rich loader.
- `packages/bodhi-pi/e2e/data/{input-transform,pirate,redact-secrets,dynamic-tools}/.bodhi-pi/extensions/<slug>.js` — phase 1.
- `packages/bodhi-pi/e2e/data/register-provider/.bodhi-pi/extensions/register-provider/{package.json,src/index.ts}` — phase 4.
- `packages/bodhi-pi/e2e/helpers/extension-loaders/node-package-loader.ts` (+ unit test, + barrel) — phase 4. Rich loader supporting flat `.js`/`.mjs`/`.cjs` files AND directory entries with `package.json` (jiti TS transpile).

### Dependency

- `jiti` — added in phase 4 to `packages/bodhi-pi/package.json` (devDep) for the in-memory harness; phase 5 adds it to `e2e/test-app-cli/package.json` and `e2e/test-app-http/package.json` so the spawned hosts can use the same rich loader.

## Architecture

The rich loader is introduced in **phase 4** — not earlier. Phases 1–3 use only the existing flat-`.js` loader path (already in `createNodeExtensionLoader` for cli/http; replicated as a small dynamic-import helper for in-memory). Reading the architecture sections below alongside the phase plan tells you exactly when each piece lands.

### Rich Node-package loader (`e2e/helpers/extension-loaders/node-package-loader.ts`) — phase 4

Public shape mirrors the existing flat loader:

```ts
export interface NodePackageLoaderOptions {
  cwd: string;
  extensionsDir?: string;  // default: ".bodhi-pi/extensions"
}
export async function createNodePackageExtensionLoader(
  opts: NodePackageLoaderOptions,
): Promise<RegisteredExtension[]>;
```

Walks `<cwd>/<extensionsDir>/` entries (sorted, deterministic). For each entry:

- **File** with extension `.js` / `.mjs` / `.cjs` → native `await import(pathToFileURL(...))` (identical to today's behavior).
- **Directory** → look for `package.json`. If present and it has `"pi": { "extensions": [...] }`, treat each listed entry as a loadable module (jiti for `.ts`, native for `.js`). If `package.json` is absent or has no `pi.extensions` field, fall back to convention: `index.ts` (jiti), `index.js` (native), `index.mjs` (native). First match wins.
- Anything else (`.txt`, hidden files, etc.) → skipped.

Each loaded module's default export must be a function `(pi) => void | Promise<void>` — identical to today's `ExtensionFactory`. Bad extensions log and skip; peers continue. This matches the existing canonical loader behavior so swap is drop-in.

The jiti instance is created once per `createNodePackageExtensionLoader` call:

```ts
const jiti = createJiti(import.meta.url, { interopDefault: true });
```

No virtual modules, no alias remapping — the e2e harness runs in the unbuilt monorepo, so jiti resolves `@earendil-works/pi-ai` etc. naturally via Node's module walk.

### Harness seeding flow

`E2EHarnessOptions` gains:

```ts
bodhiPiFixture?: string;  // e.g. "register-provider"; resolved against
                           // packages/bodhi-pi/e2e/data/<value>/.bodhi-pi/
```

Per-runtime behavior (all in `e2e/helpers/seed-bodhi-pi.ts`):

| Runtime | What the harness does |
|---|---|
| in-memory | Resolve source folder. Run `createNodePackageExtensionLoader({ cwd: <source>, ... })` to get `RegisteredExtension[]`. Pass them to `createTestHarness({ extensionFactories })`. Also copy non-extension files (`commands/`, `skills/`, `settings.json`, ...) into the in-memory FS at `<harness.cwd>/.bodhi-pi/...`. |
| cli | `await fs.symlink(srcBodhiPi, path.join(harnessCwd, ".bodhi-pi"), "dir")`. Drop the `--no-extensions` flag from the spawn args. Node's module resolution follows symlinks so the spawned child's rich loader can `import` from `@earendil-works/*` via the monorepo node_modules. |
| http | Same symlink, into the per-user workspace dir. The shared http server's `wireAgentForRequest` already calls the rich loader on every request — it picks up the symlinked snapshot. |

Symlink (rather than copy) lets the loader's module resolution walk back to the monorepo's `node_modules`. No `NODE_PATH` hacks, no nested `node_modules`. On macOS / Linux symlinks-as-directories are native; we don't target Windows.

### `register-provider` parameterization

Because the fixture now lives in a directory with `package.json`, it can `import { getModel } from "@earendil-works/pi-ai"` cleanly via jiti — no template substitution needed. API key reads `process.env.ANTHROPIC_API_KEY` at load time (in-memory: inherited; cli: passed via spawn env; http: inherited by global-setup'd server). Charter unaffected — flat `.js` extensions still can't import npm packages, but a package-mode extension can.

```ts
// e2e/data/register-provider/.bodhi-pi/extensions/register-provider/src/index.ts
import { getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@bodhiapp/bodhi-pi";

export default (pi: ExtensionAPI) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("register-provider: ANTHROPIC_API_KEY required");
  const model = getModel("anthropic", "claude-haiku-4-5");
  pi.registerProvider("ext-anthropic", { model, getApiKey: () => apiKey });
};
```

```json
// e2e/data/register-provider/.bodhi-pi/extensions/register-provider/package.json
{
  "name": "register-provider-ext",
  "private": true,
  "type": "module",
  "pi": { "extensions": ["src/index.ts"] }
}
```

### Other four fixtures: flat `.js`

`input-transform`, `pirate`, `redact-secrets`, `dynamic-tools` need nothing from npm. They stay as **single-file `.js`** under `.bodhi-pi/extensions/<name>.js` — exercising the flat-`.js` path of the rich loader. This way the test matrix proves both modes (flat-`.js` AND package-mode) work uniformly across all three runtimes.

`dynamic-tools` replaces `Type.Object(...)` with an inline JSON Schema literal:

```js
// e2e/data/dynamic-tools/.bodhi-pi/extensions/dynamic-tools.js
export default (pi) => {
  pi.registerTool({
    name: "bodhi_echo",
    description: "Echo a message verbatim. Useful for testing tool-call dispatch.",
    parameters: {
      type: "object",
      properties: { message: { type: "string", description: "Text to echo back" } },
      required: ["message"],
    },
    execute: async (_id, params) => ({
      content: [{ type: "text", text: `echoed: ${params.message}` }],
      details: {},
    }),
  });
};
```

## Per-test data folder layout

```
packages/bodhi-pi/e2e/data/
  input-transform/
    .bodhi-pi/
      extensions/
        input-transform.js
  pirate/
    .bodhi-pi/
      extensions/
        pirate.js
  redact-secrets/
    .bodhi-pi/
      extensions/
        redact-secrets.js
  dynamic-tools/
    .bodhi-pi/
      extensions/
        dynamic-tools.js
  register-provider/
    .bodhi-pi/
      extensions/
        register-provider/
          package.json
          src/
            index.ts
```

Tests:

```ts
const h = await createE2EHarness({
  models: [model], defaultModelId: model.id, getApiKey: ...,
  bodhiPiFixture: "input-transform",
});
```

## Implementation phases (depth-first per runtime; simple fixtures before complex)

One commit per phase. Each phase ends green on the in-scope project(s), then monorepo `just test` green. The 4 simple fixtures cross all three runtimes BEFORE the rich-loader work starts for `register-provider`. This keeps phase-N failures bisectable to one runtime × one feature.

During phases 1–3, the `register-provider` test stays on its current code path: `test.runIf(isRuntime("in-memory"))` + the existing `extensionFactories` option. The `extensionFactories` option on `E2EHarnessOptions` stays for that single test until phase 4 retires it.

### Phase 1 — In-memory, 4 simple flat-`.js` fixtures

Goal: 4 of 5 tests green under `|in-memory|` using `bodhiPiFixture`. `register-provider` stays `runIf(in-memory)` on its old path. No rich loader yet.

1. Create data folders for the 4 fixtures (flat `.js`, no `package.json`):
   - `e2e/data/input-transform/.bodhi-pi/extensions/input-transform.js`
   - `e2e/data/pirate/.bodhi-pi/extensions/pirate.js`
   - `e2e/data/redact-secrets/.bodhi-pi/extensions/redact-secrets.js`
   - `e2e/data/dynamic-tools/.bodhi-pi/extensions/dynamic-tools.js` (inline JSON-Schema literal)
2. Add `bodhiPiFixture?: string` to `E2EHarnessOptions`.
3. Add a small helper `e2e/helpers/seed-bodhi-pi.ts` exporting `loadFixtureFactoriesFromSource(fixtureName): Promise<RegisteredExtension[]>` — resolves to `packages/bodhi-pi/e2e/data/<fixtureName>/.bodhi-pi/extensions/`, walks the flat `.js` files via `await import(pathToFileURL(absPath))`, wraps each module's default export as a `RegisteredExtension { name, factory }` (name = basename without extension).
4. In `createInMemoryHarness`: when `bodhiPiFixture` is set, call the helper; merge the result into the `extensionFactories` passed to `createTestHarness`. Also copy non-extension `.bodhi-pi/` artifacts (commands/skills/settings, if any in the fixture folder) into `harness.filesystem` at `<cwd>/.bodhi-pi/...`. For these 4 fixtures there's no non-extension content yet, so this step is a no-op.
5. Rewrite the 4 corresponding tests in `e2e/shared/extensions.e2e.ts` to use `bodhiPiFixture: "<slug>"` instead of `extensionFactories: [asRegistered(...)]`. Drop their `runIf` guards. Keep `register-provider`'s `runIf(in-memory)` and `extensionFactories` path untouched.
6. Run `npm run test:e2e -- --project in-memory extensions.e2e.ts` → 5 green (4 via new path + 1 via old path).
7. Run full `npm run test:e2e` → cli and http still skip 4 of 5 extension tests (`runIf(!isRuntime("cli") && !isRuntime("http"))` placeholder on those 4 — added in this phase for clarity), plus the original `runIf(in-memory)` on `register-provider`. Phase 2/3 lift these placeholders.
8. `just test` green.
9. Commit: `bodhi-pi e2e: in-memory loads 4 simple extensions from e2e/data/<slug>/.bodhi-pi (flat .js)`.

### Phase 2 — Add CLI for the 4 simple fixtures

Goal: the same 4 tests also green under `|cli|`.

1. In `createCliHarness`: when `bodhiPiFixture` is set, `await fs.symlink(<repo>/packages/bodhi-pi/e2e/data/<bodhiPiFixture>/.bodhi-pi, path.join(harnessCwd, ".bodhi-pi"), "dir")`. Cleanup unlinks the symlink before removing tmpdir.
2. Drop `--no-extensions` from the spawn args in the cli harness when `bodhiPiFixture` is set. (Keep `--no-extensions` as the default when no fixture is requested, so existing tests that don't seed extensions stay isolated.)
3. The existing flat-`.js` `createNodeExtensionLoader` in `test-app-cli/src/cli.ts` already handles `.js` files — no test-app change yet.
4. Lift the cli portion of the runtime placeholder on the 4 ported tests.
5. Run `npm run test:e2e -- --project cli extensions.e2e.ts` → 4 green, 1 skipped (`register-provider`).
6. Regression: in-memory still green.
7. `just test` green.
8. Commit: `bodhi-pi e2e: cli loads 4 simple extensions from symlinked e2e/data/<slug>/.bodhi-pi`.

### Phase 3 — Add HTTP for the 4 simple fixtures

Goal: the same 4 tests also green under `|http|`. Combined with phases 1+2, the 4 simple tests are runtime-blind.

1. In `createHttpHarness`: when `bodhiPiFixture` is set, symlink `e2e/data/<bodhiPiFixture>/.bodhi-pi` into the per-user workspace `harness.cwd/.bodhi-pi`. Cleanup unlinks before workspace rm.
2. The shared http server's `wireAgentForRequest` already calls `createNodeExtensionLoader({ cwd })` per request — it picks up the symlinked snapshot automatically. No test-app change yet.
3. Lift the http portion of the runtime placeholder on the 4 ported tests.
4. Run `npm run test:e2e -- --project http extensions.e2e.ts` → 4 green, 1 skipped.
5. Regression: in-memory + cli still green.
6. `just test` green.
7. Commit: `bodhi-pi e2e: http loads 4 simple extensions from symlinked e2e/data/<slug>/.bodhi-pi`.

### Phase 4 — In-memory rich loader + `register-provider` Node package

Goal: `register-provider` test passes under `|in-memory|` via the new rich loader. cli + http remain on the legacy `runIf(in-memory)` skip until phase 5.

1. Add `jiti` as devDep to `packages/bodhi-pi/package.json`.
2. Create `e2e/helpers/extension-loaders/node-package-loader.ts` — `createNodePackageExtensionLoader({ cwd, extensionsDir })`. Walks `<cwd>/<extensionsDir>/` entries:
   - File `.js`/`.mjs`/`.cjs` → native `import(pathToFileURL(...))`.
   - Directory with `package.json` containing `"pi": { "extensions": [...] }` → for each entry, jiti for `.ts`, native import for `.js`.
   - Directory without manifest → convention: `index.ts` (jiti) > `index.js` (native).
   Returns `RegisteredExtension[]` (name = directory basename or file basename).
3. Add a small unit test next to it (`*.test.ts`) covering both modes against a temp dir. Runs under `npm test` (not `test:e2e`).
4. Update `e2e/helpers/seed-bodhi-pi.ts`: switch the in-memory path's loader from the flat dynamic import to the rich loader. Existing 4 flat-`.js` fixtures keep working via the rich loader's flat-file branch — regression-tested by phase 1's tests still passing.
5. Create `e2e/data/register-provider/.bodhi-pi/extensions/register-provider/`:
   - `package.json` — `{ "name": "register-provider-ext", "private": true, "type": "module", "pi": { "extensions": ["src/index.ts"] } }`
   - `src/index.ts` — uses `import { getModel } from "@earendil-works/pi-ai"`, reads `process.env.ANTHROPIC_API_KEY`, calls `pi.registerProvider("ext-anthropic", { model, getApiKey: () => apiKey })`.
6. Rewrite the `register-provider` test in `extensions.e2e.ts` to use `bodhiPiFixture: "register-provider"`. Keep `runIf(isRuntime("in-memory"))` temporarily (cli/http arrive in phase 5).
7. The `extensionFactories` option on `E2EHarnessOptions` is now unreferenced — **remove it**, along with `makeRegisterProviderFactory` in `test/helpers/extension-fixtures.ts` (and any other unused exports from that file).
8. Run `npm run test:e2e -- --project in-memory extensions.e2e.ts` → 5 green.
9. Regression: cli + http still green for the 4 simple tests (1 still skipped under those).
10. `just test` green.
11. Commit: `bodhi-pi e2e: rich Node-package loader (jiti); register-provider runs as a TS package under in-memory`.

### Phase 5 — CLI + HTTP for `register-provider`

Goal: `register-provider` test passes under all 3 runtimes. `runIf` guards are gone for good.

1. Add `jiti` as a dep to `e2e/test-app-cli/package.json` and `e2e/test-app-http/package.json`.
2. `e2e/test-app-cli/src/cli.ts`: swap `createNodeExtensionLoader` for `createNodePackageExtensionLoader` (import from `@e2e/helpers/extension-loaders/index.js`). Existing flat-`.js` extensions keep working via the rich loader's flat-file branch.
3. `e2e/test-app-http/src/server/agent/wire-agent.ts`: same swap.
4. Rebuild test-apps.
5. Drop the `runIf(isRuntime("in-memory"))` from the `register-provider` test.
6. Run `npm run test:e2e -- --project cli extensions.e2e.ts` → 5 green.
7. Run `npm run test:e2e -- --project http extensions.e2e.ts` → 5 green.
8. Regression: in-memory still 5 green.
9. Commit: `bodhi-pi e2e: cli + test-app-http use the rich loader; register-provider runs across all 3 runtimes`.

### Phase 6 — Full gate + flaky retries + commit

1. `cd packages/bodhi-pi && npm run test:e2e` → header `55 passed / 0 skipped`.
2. `just test` (monorepo) — if anything flakes, rerun the specific failing project once before treating as a genuine failure.
3. Fix genuine failures (not flakes). Commit any fix as its own commit.
4. Holistic clean-up sweep on the files touched in phases 1–5: drop obvious comments, dead imports, residual `--no-extensions` branches, etc.
5. Commit (if any clean-up): `bodhi-pi e2e: clean up dead extensionFactories paths and unused fixtures`.

## Open risks / things to verify during implementation

- **jiti + ESM TS interop**: the e2e package is ESM (`"type": "module"`). jiti's `interopDefault: true` should give us `module.default` cleanly. Verify in phase 1's unit test.
- **`getModel` import resolution from data folder**: from `<repo>/packages/bodhi-pi/e2e/data/register-provider/.bodhi-pi/extensions/register-provider/src/index.ts`, Node's upward walk reaches `<repo>/node_modules/@earendil-works/pi-ai`. Confirmed by inspection but worth a manual check.
- **Symlink semantics on cli child**: spawned child reads `harness.cwd/.bodhi-pi/extensions/...`; Node's loader follows the symlink for both `readdir` and `import()`. Should work natively on macOS/Linux. CI is Linux — fine.
- **`--no-extensions` removal side-effects**: confirm no other shared test relies on extensions being absent under cli. The grep should be empty.
- **Production hosts untouched**: phase 2 modifies only e2e test-apps. `packages/bodhi-pi-cli/`, `packages/bodhi-pi-http/`, `packages/bodhi-pi-node/`, `packages/bodhi-pi-browser/` get zero changes.

## Verification

- `cd packages/bodhi-pi && npm run test:e2e -- --project in-memory extensions.e2e.ts` — all 5 tests green.
- `cd packages/bodhi-pi && npm run test:e2e -- --project http extensions.e2e.ts` — all 5 tests green.
- `cd packages/bodhi-pi && npm run test:e2e -- --project cli extensions.e2e.ts` — all 5 tests green.
- `cd packages/bodhi-pi && npm run test:e2e` — header `55 passed / 0 skipped`.
- `just test` — green.
- `git diff --name-only origin/main..HEAD packages/bodhi-pi-cli/ packages/bodhi-pi-http/ packages/bodhi-pi-node/ packages/bodhi-pi-browser/ packages/bodhi-pi/src/` — empty (production untouched).
- Manual: with one extension test running under cli, `ls -la <tmp dir>/.bodhi-pi` should show the symlink pointing at the data folder.

## Notes / non-goals

- This work does **not** promote the rich loader into a published bodhi-pi-node v2. It lives in e2e for now. Production CLIs continue to use the flat-`.js` loader. Promotion is a follow-up if/when a real-world extension needs npm deps.
- This work does **not** introduce a rich loader to bodhi-pi-browser / bodhi-pi-web / bodhi-pi-chrome-ext. Their "JS-only by charter" stays in force.
- The `extensionFactories` API on `E2EHarnessOptions` may stay (additive) or be removed (per question 4 from the events work). Decide during phase 3 based on whether any non-extensions test still passes it.
