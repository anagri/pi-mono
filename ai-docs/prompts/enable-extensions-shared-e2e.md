# Kickoff: enable `e2e/shared/extensions.e2e.ts` across all three runtimes

This is a new chat session. Read this prompt end-to-end, explore the codebase, ask clarifying questions, then propose a plan via `ExitPlanMode`. Do NOT start implementing until the plan is approved. **Sequence: implement this AFTER the sibling prompt `enable-events-shared-e2e.md` lands.** Events first, extensions second.

## Goal

`packages/bodhi-pi/e2e/shared/extensions.e2e.ts` is currently `test.runIf(isRuntime("in-memory"))` — 5 tests that skip under `|cli|` and `|http|`. Remove the guard. After both this and the events kickoff are landed, every `e2e/shared/` test runs under all three runtimes with zero runtime-skip-only tests.

End state in the consolidated test:e2e report: `55 passed / 0 skipped`.

## Why these tests skip today

The tests construct in-process **extension factories** in `packages/bodhi-pi/test/helpers/extension-fixtures.ts` — JS functions like:

```ts
export const inputTransform: ExtensionFactory = (ctx) => ({
  hooks: { onPromptInput: (text) => text.startsWith("?quick") ? "...transformed..." : text },
});
```

Each test passes one or more factories via `createE2EHarness({ ..., extensionFactories: [asRegistered("input-transform", inputTransform), ...] })`. The factory closure references in-process state and the agent runs it in-band.

Factory functions are JS closures. They can't be marshaled across the cli stdio or http boundaries. Hence the runtime guard.

## How extensions actually load in non-in-memory runtimes

The cli and http hosts have always supported extensions — they're loaded from disk via `createNodeExtensionLoader` (`packages/bodhi-pi-node/src/extensions/node-extension-loader.ts`, also inlined under `packages/bodhi-pi/e2e/helpers/node-adapters/extension-loader.ts`). The loader walks `<cwd>/.bodhi-pi/extensions/*.{js,mjs,cjs}` and `await import(pathToFileURL(...))`s each one. Each file's default export must be a function matching `ExtensionFactory`. The agent picks them up identically to in-process factories.

So the runtime-side surface already exists — what we lack is the test-side mechanism to **emit each fixture as a real .js file before the test runs**, instead of registering it in-process.

The harness already constructs a per-test workspace dir (`harness.cwd`) and exposes `harness.filesystem` for seeding. The wire is there. What's missing is a build/copy step that turns each TS fixture into a standalone JS module on disk.

## Current fixtures to port

`packages/bodhi-pi/test/helpers/extension-fixtures.ts` — confirm during exploration. Likely contents:

- `inputTransform` — rewrites `?quick`-prefixed prompts.
- `pirate` — appendSystemPrompt that nudges the model into pirate-speak.
- `redactSecrets` — registers a `tool_result` hook that scrubs API keys from tool output.
- `dynamicTools` — registers a `bodhi_echo` tool dynamically.
- `makeRegisterProviderFactory({...})` — registers an extension-supplied provider (e.g., Anthropic) so the agent can route to it.

Each factory is a small TS function returning an extension definition. All transformable to standalone `.js` files (the codebase explicitly bans transpilers at runtime — bodhi-pi extensions are JS-only by charter, see `packages/bodhi-pi-node/src/extensions/node-extension-loader.ts` header comment).

## Direction (open to re-explore)

1. **Each fixture becomes a standalone .js file**, written to disk under `harness.cwd/.bodhi-pi/extensions/<name>.js` before the agent boots. The agent loads it identically across all three runtimes (in-memory uses an in-memory FS that holds the .js content; cli/http use Node's real FS).
2. **Maintain the .js files in source-controlled form**, not as runtime-transpiled output. Either:
    - have e2e/data/<test>/.bodhi-pi/ folder that contains the snapshot of the `.bodhi-pi` folder that we want, containing extensions, slash commands etc., and is loaded as in-memory fs for in-memory, or rsync to cwd for runtimes reading from the filesystem
   Pick what's cleanest after exploring.
3. **Tests stay runtime-blind**. Drop `test.runIf(...)` from `extensions.e2e.ts`. The tests seed the fixture files via `harness.filesystem.writeTextFile` (in-memory) or directly to the tmpdir (cli/http) — but a uniform API on the harness should hide that detail. The harness probably grows a helper like `harness.seedBodhiPi("test")` that copies pre-built folder files into the right place per runtime.

4. **The `extensionFactories` harness option becomes deprecated** for new shared tests — file-based loading is the canonical path.

## Critical files (read these first)

- `ai-docs/plans/20200511-e2e-*.md` — implemented plans consolidated/shared e2e tests.
- `packages/bodhi-pi/e2e/CLAUDE.md` — e2e conventions (`@e2e/*` alias, no bodhi-pi-* sibling deps, vitest≠playwright separation, 30s timeout default).
- `packages/bodhi-pi/e2e/shared/extensions.e2e.ts` — the 5 tests being unblocked.
- `packages/bodhi-pi/test/helpers/extension-fixtures.ts` — the in-process factories.
- `packages/bodhi-pi/e2e/helpers/node-adapters/extension-loader.ts` — the file-based loader used by cli + http.
- `packages/bodhi-pi/e2e/helpers/harness.ts` — current dispatch. The `extensionFactories` option needs a new sibling for file-based seeding.
- `packages/bodhi-pi/src/extensions/` (or wherever extension types live) — confirm what `ExtensionFactory` actually exports and what shape a `.js` module's default export must take.

## Things to explore + decide before writing code

- Fewer consolidated tests, so we have few e2e/data/<test> folders, a single test folder with variety of non-conflicting extension can test various scenarios 
- **Static vs generated .js**: are the fixtures small enough to hand-write as `.js` files (~50–100 lines total)? If yes, single source of truth — delete the `.ts` versions. If no, set up a tiny build step.
- **`makeRegisterProviderFactory({...})`**: this fixture takes parameters (provider model, API key) at factory-construction time. A static .js file can't take TS-side parameters at "import time". Options: (a) read parameters from env vars inside the .js, (b) read from a sibling `.json` config file in `.bodhi-pi/extensions/<name>.config.json`, (c) inline the params at file-write time when the harness seeds the fixture.
- **In-memory runtime support**: the in-memory FS doesn't have `pathToFileURL`+`import()`. The current `createInMemoryFilesystem()` doesn't satisfy the loader's `fs.readdir` + `import()` calls. Investigate whether the in-memory runtime needs a different extension-loader path (an in-memory-friendly loader that uses `eval` or `vm.Module`), or whether it should accept that under in-memory the test seeds via `extensionFactories` directly (a code branch in the harness, similar to how today's test-app-http server reads from a real fs while in-memory uses the in-process FS).
- **One fixture per test, or one shared seed**: the current 5 tests each pass exactly one extension factory. If the harness seeds the `.bodhi-pi/extensions/` dir, do we seed only the one we want for THIS test, or all five and rely on the agent's loader being deterministic? Per-test seeding (write+rm) is cleaner.
- Generic enough setup to be reused by slash commands and other tests testing .bodhi-pi artifacts

## Conventions to follow (non-negotiable)

- `bodhi-pi/e2e/` must not depend on any `@bodhiapp/bodhi-pi-*` sibling package. `@e2e/*` alias for cross-folder imports.
- vitest and Playwright stay separate runners — this work is vitest-only.
- 30s global testTimeout. Document any `60_000` override.
- One commit per phase. Each phase ends with the in-scope project(s) green, then monorepo `just test` green.
- Follow depth first approach, first fix the in-memory for the changes, run test, green, then implement http for changes, include in the test run, fix test if any, green, the remove the runIf, and include cli in the run, implement, run test, fix, green
- Holistically analyze the changes, if there can be some clean up, clean code, refactor, duplication, unnecessary comments
- keep comments only for non-obvious and quirky code, do not litter with obvious comments

## Workflow

1. Read the references above in order. Build a mental model of how extensions load across the three runtimes.
2. Inspect each of the 5 fixtures in `extension-fixtures.ts`. For each, decide how it ports to a standalone `.js`.
3. Decide where the .js fixtures live and how `makeRegisterProviderFactory({...})` parameterization translates.
4. Propose a phased plan via `ExitPlanMode` after writing it to a new `ai-docs/plans/<slug>.md`. Suggested phases: (1) build the file-based seed plumbing in the harness + decide fixture format; (2) port one fixture end-to-end (`inputTransform` is simplest), get that test passing under all 3 runtimes; (3) port the remaining 4 fixtures one at a time with green gates; (4) drop the `runIf` guard; (5) gate-check across all 3 projects + just test; (6) commit.
5. Implement phase-by-phase with green gates between phases.

End state: `npm run test:e2e` from `packages/bodhi-pi` shows the extensions tests under all three project labels — no skips on extensions. Combined with the events work, `e2e/shared/` reports `55 passed / 0 skipped`. `just test` green.

## Sequencing note

Run AFTER `enable-events-shared-e2e.md`. The events prompt teaches the harness to plumb side-channel data uniformly across runtimes (events as JSON over stderr/SSE). That's a similar architectural shape to what extensions need (test-side artifacts that have to manifest as runtime-side files). Coming second means the architectural pattern is already validated and you can mirror it.
