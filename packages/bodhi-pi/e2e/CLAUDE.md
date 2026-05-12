# bodhi-pi/e2e

Real-LLM e2e for bodhi-pi. Same `e2e/shared/*.e2e.ts` files run under three Vitest projects:

| Project | Transport | Adapters | What it spawns |
|---|---|---|---|
| `in-memory` | in-process ACP pair | in-memory FS/sessions/kv | nothing |
| `cli` | ACP JSON-RPC over real stdio | `bodhi-pi-node` (real FS + SQLite) | `test-app-cli --rpc` child process |
| `http` | HTTP+SSE on `/acp` | `bodhi-pi-node` (real FS + SQLite) | bodhi-pi-http server (in-process) |

`e2e/cli-headless/` runs only under `cli`. `e2e/http-playwright/` runs only under `http`.

## Conventions

### Required env vars: global setup, not per-test

`e2e/global-setup.ts` lists every env var any test reads and fails the run upfront if any is missing. Inside tests use `process.env.NAME!` directly — do **not** call `requireEnv` per test.

```ts
// ❌
const apiKey = requireEnv("OPENAI_API_KEY");

// ✅
const apiKey = process.env.OPENAI_API_KEY!;
```

To add a new required env var: edit `global-setup.ts`. The global gate makes the test author's `!` assertion always sound.

### Timeouts

- Global `testTimeout: 30_000`. Most tests must fit here.
- One documented escape: tests that chain many real-LLM calls (e.g. compaction's 4 prompts + extMethod) take `60_000` with an explicit comment.
- Never use `}, N_000)` ad-hoc to "make it pass". Either the test fits 30s or it earns the 60s override with a written reason.

```ts
// ✅ Documented override
test(
  "real LLM /compact returns a summary and the post-compact prompt still recalls earlier facts",
  async () => { ... },
  60_000, // 4 chained prompts + compact extMethod exceeds 30s on most runs
);
```

### Three parts of a test: setup, trigger, assertion

Every test has three parts:
1. **Setup**: build a harness, seed filesystem/session state, register providers.
2. **Trigger**: call ACP (initialize → newSession → prompt, or extMethod).
3. **Assertion**: read updates / filesystem / extension response, `expect(...)`.

A normal test runs that cycle once. A **flow test** runs it multiple times (trigger + assertion repeated) over the same setup.

### When to flow-consolidate

Flow tests save the per-test setup cost (in cli runtime each setup spawns a fresh process; in http runtime each boots a fresh server). Worth doing **only when**:

- The harness/setup is identical for each scenario (same model, same provider, same seed).
- Earlier steps don't conflict with later ones — no state mutation that one step depends on being absent in another.
- Failure of one step doesn't make subsequent steps meaningless (use `expect.soft` to keep them running).

Examples in this suite:
- `commands.e2e.ts` — one harness, three slash-command scenarios (`/say-tuesday`, `/echo $1`, `/write-file`). Same seed, independent steps. **Flow-consolidated.**
- `fork-clone.e2e.ts` — one harness, two prompts shared as initial state, then `/fork` and `/clone` checked on that state. **Flow-consolidated.**
- `chat.e2e.ts` — different providers per test (Haiku vs gpt-5-mini), and the model-switch test needs both. Setup differs. **Kept granular.**
- `extensions.e2e.ts` — every test wires a different `extensionFactories`. Setup differs. **Kept granular.**

Don't merge tests just to reduce count. Merge only when the three-parts criteria above are satisfied.

### Soft assertions in flow tests

In a flow test, prefer `expect.soft(...)` so a failure in step 2 doesn't hide failures in steps 3+. Vitest collects soft failures and reports them all at end of the test.

```ts
// Step 1
expect.soft(chunkedAgentText(h.updates).toLowerCase()).toContain("tuesday");

// Step 2 — still runs even if step 1 failed
expect.soft(await h.filesystem.exists(outFile)).toBe(true);
```

Use hard `expect(...)` for setup invariants where continuing is meaningless (e.g. asserting `userEntries.length === 2` before forking on the second entry).

### Runtime-specific skipping

Use `test.runIf(isRuntime("in-memory"))` for tests that depend on JS callbacks that can't cross the cli stdio / http boundaries (extension factories, event handlers).

Use `test.runIf(!isRuntime("http"))` for tests that fail under bodhi-pi-http's per-turn agent rebuild semantics. Document the divergence in a one-line comment above the test.

### Harness

`createE2EHarness(opts)` dispatches on the runtime sentinel set by the project's setup file. Same return shape across runtimes: `{ clientConn, client, updates, filesystem, sessionStore, kvStore, cwd, cleanup }`.

- `filesystem` is a live handle (in-memory FS for `in-memory`, real Node FS at `tmpDir` for `cli`/`http`). Use it for both seeding and asserting.
- `sessionStore` / `kvStore` are in-memory stubs under `cli`/`http` — the spawned child / server owns the real backing store; tests assert at the protocol level instead.
- `cwd` defaults to `/proj` under in-memory (non-root so path concatenation stays clean), tmpDir under cli/http. Always pass `h.cwd` to `newSession` and compose paths as `${h.cwd}/file.txt`.

### Don't depend on bodhi-pi-* packages from e2e

`bodhi-pi/e2e/` must not import from `@bodhiapp/bodhi-pi-node`, `@bodhiapp/bodhi-pi-cli`, etc. Required adapters live under `e2e/helpers/` (e.g. `node-filesystem.ts` is a copy of bodhi-pi-node's `createNodeFilesystem`). If a helper drifts from its source, update the copy in lockstep.

Exception, currently retained: the `http` branch imports `buildServer` from `@bodhiapp/bodhi-pi-http/dist/server/server.js`. Listed in bodhi-pi's devDeps. Full decoupling requires either copying that source under `e2e/test-app-http/` or extending bodhi-pi-http's CLI args so the harness can spawn it like `test-app-cli`.

### Anti-patterns

| ❌ | ✅ |
|---|---|
| `requireEnv("OPENAI_API_KEY")` per test | `global-setup.ts` lists it; tests use `process.env.OPENAI_API_KEY!` |
| `}, 60_000)` to hide a slow test | Either fit 30s or document the override |
| Hardcoded paths like `"/proj/.bodhi-pi/foo"` | `${h.cwd}/.bodhi-pi/foo` |
| `expect()` in flow steps that should keep running | `expect.soft()` |
| 5 granular tests with identical setup | One flow test with shared setup + `expect.soft` per step |
| Importing from `@bodhiapp/bodhi-pi-node` | Add the helper under `e2e/helpers/` |
