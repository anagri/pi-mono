# bodhi-pi-cli

Reference Node host for `@bodhiapp/bodhi-pi`. Hand-rolled REPL CLI for live-testing the agent against a real working tree and a real LLM. Feature-equivalent to `bodhi-pi-web` — every bodhi-pi capability has a Node-side e2e here proving the same features work through Node adapters.

`README.md` covers user-facing setup. Live testing tool, not a product. Stays small, easy to read, in lockstep with bodhi-pi's evolving surface.

## Architecture pillars

**In-process ACP pair.** No real network transport — `repl/repl.ts` builds two `TransformStream`s and connects `AgentSideConnection` ↔ `ClientSideConnection` directly. Mirrors `bodhi-pi/test/helpers/harness.ts`. Switching to a real stdio transport is a future milestone.

**Node adapters from `@bodhiapp/bodhi-pi-node`.** `createNodeFilesystem(cwd)` + `createSqliteSessionStore(dbPath)` + `createNodeScriptExecutor()`. The `createCliAgent` factory in `src/agent.ts` wires them into `createBodhiPiAgent` and returns `{ factory, sessionStore, filesystem, cwd, models }`.

**Slash-command set is canonical.** `src/repl/commands.ts` is the source of truth for `/help`, `/new`, `/sessions`, `/resume`, `/model`, `/quit`. `bodhi-pi-web/src/ui/commands.ts` is a port of this — keep them in sync (drop `/quit` for the web, it has no terminal).

**Plain `chalk` rendering.** No TUI library. Streaming text via `process.stdout.write`; tool calls as cyan/dim/red lines. Hand-rolled means hand-rolled — no `pi-tui` dependency.

**Config from env + flags.** `dotenv` loads `.env`; `--model`, `--system-prompt`, `--db` flags parsed by hand (no `commander`/`yargs`). Models filtered to those with available API keys.

## Key files

| Path | Role |
|---|---|
| `src/cli.ts` | Shebang, argv parse, dotenv, `createCliAgent` → `runRepl` |
| `src/agent.ts` | `createCliAgent(opts)` — wires Node adapters into `createBodhiPiAgent`. Source of truth for harness wiring. |
| `src/config.ts` | `resolveConfig(argv)` — model precedence, API key resolution, dbPath, systemPrompt |
| `src/repl/repl.ts` | readline loop; in-process ACP pair; routes slash commands locally vs forwarding as `prompt` |
| `src/repl/commands.ts` | Canonical slash-command implementations |
| `src/repl/render.ts` | `Renderer` for streaming text + tool-call notifications via chalk |
| `test/helpers/cli-harness.ts` | `createCliTestHarness({ model, apiKey })` — tmpdir + SQLite + in-process pair, used by all e2e specs |
| `test/agent.test.ts` | Integration tests against `createCliAgent` with faux providers (no network) — write/read/edit/run_script/jail/persistence-across-instances |
| `e2e/repl.e2e.ts` | Smoke: gpt-4o-mini round-trip, end_turn + chunk assertions |
| `e2e/fs.e2e.ts` | Real LLM exercises the FS tools against a tmpdir |
| `e2e/scripts.e2e.ts` | Real LLM invokes `run_script` (Node spawn) |
| `e2e/sessions.e2e.ts` | Cross-instance restore (kill + reopen against same dbPath) |
| `e2e/global-setup.ts` | Loads `.env.test` for e2e |
| `drizzle.config.ts` | Removed in M3 of cli-m3 — schema lives in `bodhi-pi-node` now |

## Source code rules

- **No agent logic.** Wire adapters; route input; render output. Anything beyond that belongs in `bodhi-pi`.
- **No `pi-tui`.** Plain chalk only. The cli is a debugging tool, not a UX showcase.
- **Match `bodhi-pi-web`'s slash-command set.** Same names, same semantics. `/quit` is cli-only (no terminal in browser); everything else mirrors.
- **`createCliAgent` is the test boundary.** All tests + e2e go through it. Never hand-build the same wiring elsewhere — drift between `cli.ts` and tests is exactly what M2 of cli-m2 fixed.
- **`vitest.config.ts` source-aliases `@bodhiapp/bodhi-pi-node`** → `../bodhi-pi-node/src/index.ts`. Without it, tests load stale `dist/` and silently mask bugs.
- **No `commander`/`yargs`.** Hand-rolled flag parsing keeps deps lean. Add only when complexity actually warrants it.
- **e2e uses `gpt-4o-mini`.** Cheap, non-reasoning, deterministic enough. Cross-provider tests happen in `bodhi-pi/e2e/chat.e2e.ts`, not here.

## Test conventions

- **Two test layers.** `test/` for integration with faux providers (no network); `e2e/` for real LLM round-trips. Same harness shape via `createCliTestHarness`.
- **`createCliTestHarness({ model, apiKey })` returns `{ clientConn, updates, tmpDir, dbPath, cleanup }`.** Always call `cleanup` in `afterEach` — leaves no `/tmp/bodhi-pi-cli-e2e-*` debris.
- **Real tmpdirs, real SQLite.** No mocking the FS or DB. Mocks defeat the purpose of a "live test" tool.
- **Assert side-effects + stable substrings, not exact model text.** Same rule as bodhi-pi's e2e.
- **e2e `.env.test`** is gitignored. Source `.env.test.example` describes required keys.
- **Test workspaces live as real files under `test/fixtures/<scenario>/`.** Each scenario is a checked-in directory with `.bodhi-pi/{commands,skills,extensions}` populated as actual files; specs point the harness at it via `createCliTestHarness({ fixtureDir })` (cwd = fixtureDir, dbPath stays ephemeral in `os.tmpdir()` so concurrent specs never lock-conflict). Runtime templating via a `templates`-style constant in `seed-workspace.ts` is reserved only for cases that bake an absolute tmpdir-derived path into the fixture body (e.g. scripted-skill's `{SCRIPT_PATH}` placeholder). The same fixture tree is the source of truth for `bodhi-pi-web/e2e/{commands,skills,extensions}.spec.ts` — both reference clients consume identical bytes.

## Feature workflow

When `bodhi-pi` ships a new feature, the cli changes follow this order:

1. If the feature requires a new host-injected interface, the adapter lives in `bodhi-pi-node` first (with its own unit tests).
2. Wire it into `src/agent.ts:createCliAgent`.
3. If the feature surfaces in the REPL (slash command, render path, env flag), add it to `src/repl/`. Keep slash-command names identical to `bodhi-pi-web/src/ui/commands.ts`.
4. Add an `e2e/*.e2e.ts` spec mirroring the corresponding `bodhi-pi/e2e/*.e2e.ts` — real `gpt-4o-mini`, real tmpdir, real SQLite, asserts the same side-effects + substrings.
5. Update `bodhi-pi-web` in lockstep so both reference clients prove the feature.

The browser equivalent of every cli e2e lives in `bodhi-pi-web/e2e/`. Drift between the two is a regression risk — both must pass before a feature is "done".
