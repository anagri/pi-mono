# bodhi-pi-cli — hand-rolled REPL CLI for live-testing bodhi-pi

## Context

`@bodhiapp/bodhi-pi` is an embeddable, ACP-speaking coding agent. Today it can only be exercised via:
- the in-process `vitest` harness (`test/`, `e2e/`), which is great for assertions but not for ad-hoc exploration, and
- whatever editor eventually integrates ACP — none exists in this repo.

We want a thin developer CLI — `bodhi-pi-cli` — that wires up `createBodhiPiAgent` to a terminal REPL so we can poke at the real agent against a real working tree with a real model, end-to-end, without spinning up an editor. It is a **live-test tool**, not a product. It must be small, easy to read, and stay in sync with bodhi-pi's evolving surface.

Decisions already locked in (from clarifying questions):
- **Transport**: in-process ACP pair (`createInProcessAcpPair`), the same pattern `test/helpers/harness.ts` uses.
- **UX**: interactive REPL (slash-commands for new-session / model-switch / quit). No one-shot mode in v1.
- **Filesystem**: hand-rolled `node:fs/promises` adapter, scoped to the cwd the CLI is launched in.
- **Sessions**: SQLite + Drizzle ORM with **drizzle-kit migrations**, single DB file at `~/.bodhi-pi-cli/sessions.db`, cwd is a row-level namespace (every query filters/inserts `cwd`).
- **Config**: env vars + CLI flags. `dotenv` loads `.env` from cwd. `--model <id>` chooses model; falls back to `BODHI_MODEL` then to first model whose provider has a key.
- **Dependency rule**: depends on `@bodhiapp/bodhi-pi`, `@mariozechner/pi-ai`, and ACP SDK. **No** dependency on `pi-coding-agent`. `pi-agent-core` is transitive via bodhi-pi and should not be a direct dep.

## Package layout

```
packages/bodhi-pi-cli/
  package.json            # name @bodhiapp/bodhi-pi-cli, "type":"module", bin: bodhi-pi-cli -> dist/cli.js
  tsconfig.build.json     # extends ../../tsconfig.base.json, rootDir src, outDir dist
  drizzle.config.ts       # drizzle-kit config; schema -> ./src/sessions/schema.ts; out -> ./drizzle
  drizzle/                # generated migration .sql files (committed)
  README.md               # short: install/build/run, env vars, slash commands
  .env.example            # ANTHROPIC_API_KEY=, OPENAI_API_KEY=, BODHI_MODEL=
  src/
    cli.ts                # shebang, argv parse, dotenv, main()
    config.ts             # resolveConfig(): models[], defaultModelId, getApiKey, systemPrompt
    fs/node-filesystem.ts # createNodeFilesystem(rootCwd): Filesystem
    sessions/
      schema.ts           # drizzle table defs (sessions, session_entries)
      sqlite-session-store.ts  # createSqliteSessionStore(dbPath): SessionStore
      migrate.ts          # runMigrations(db): apply ./drizzle/*.sql via drizzle-orm migrator
    repl/
      repl.ts             # readline loop, slash-command dispatcher
      render.ts           # streaming renderer (chalk) for sessionUpdate notifications
      commands.ts         # /new, /sessions, /resume <id>, /model <id>, /help, /quit
  test/
    fs.test.ts            # NodeFilesystem against tmp dir (vitest)
    sessions.test.ts      # SqliteSessionStore round-trip (in-memory sqlite via :memory: or tmp file)
    config.test.ts        # model/key resolution
  e2e/
    repl.e2e.ts           # spawn one prompt through the in-process pair, assert stream, gpt-5-mini only
```

## Public surface and how it composes

The single CLI entry point assembles four host-injected pieces and hands them to bodhi-pi:

```ts
// packages/bodhi-pi-cli/src/cli.ts (shape)
import { createBodhiPiAgent, AgentSideConnection } from "@bodhiapp/bodhi-pi";
import { createNodeFilesystem } from "./fs/node-filesystem.js";
import { createSqliteSessionStore } from "./sessions/sqlite-session-store.js";
import { resolveConfig } from "./config.js";
import { runRepl } from "./repl/repl.js";

const cfg = await resolveConfig({ argv: process.argv });
const filesystem = createNodeFilesystem(process.cwd());
const sessionStore = await createSqliteSessionStore(cfg.dbPath);

const factory = createBodhiPiAgent({
  models: cfg.models,
  defaultModelId: cfg.defaultModelId,
  getApiKey: cfg.getApiKey,
  sessionStore,
  filesystem,
  systemPrompt: cfg.systemPrompt,
});

await runRepl({ factory, cwd: process.cwd(), sessionStore, models: cfg.models });
```

`runRepl` builds an in-process ACP pair (mirroring `packages/bodhi-pi/test/helpers/harness.ts:8-44`) where:
- the **agent side** is `factory(conn)`,
- the **client side** captures `sessionUpdate` notifications and pipes them straight to `render.ts`,
- `requestPermission` auto-approves in v1 (REPL flag `--ask-permission` can flip this later).

## Filesystem adapter (`fs/node-filesystem.ts`)

Implements the 7-method `Filesystem` interface from `packages/bodhi-pi/src/filesystem/filesystem.ts:12-33` directly on `node:fs/promises`. Notes:

- Constructor takes a `rootCwd` and rejects any absolute path that escapes the root (`!path.resolve(p).startsWith(rootCwd + path.sep)`). This is the **safety jail** for live testing on real working trees.
- `exists` swallows all errors → `false`, per JSDoc.
- `mkdir({recursive: true})` and `remove({recursive: true})` map straight to `fs.mkdir`/`fs.rm` options.
- No watchers, no caching — bodhi-pi expects each call to hit the underlying FS.
- Tests: temp dir under `os.tmpdir()`, exercise read/write/list/stat/exists/mkdir/remove, including error paths (ENOENT, EISDIR, jail violation).

## Sessions (Drizzle + drizzle-kit + better-sqlite3)

### Why Drizzle-kit migrations

Schema **will** drift as bodhi-pi's `SessionEntry` discriminator grows (today: `message | model_change`). Migrations let us evolve without losing local sessions across CLI versions. Cost is one extra dev-dep and a `drizzle/` folder.

### Schema (`sessions/schema.ts`)

```ts
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  cwd: text("cwd").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => ({
  cwdUpdatedIdx: index("sessions_cwd_updated_idx").on(t.cwd, t.updatedAt),
}));

export const sessionEntries = sqliteTable("session_entries", {
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),     // monotonic per-session insert order
  entryId: text("entry_id").notNull(),
  type: text("type").notNull(),              // SessionEntry["type"]
  timestamp: integer("timestamp").notNull(),
  payload: text("payload").notNull(),        // JSON.stringify(SessionEntry)
}, (t) => ({
  pk: primaryKey({ columns: [t.sessionId, t.ordinal] }),
}));
```

Rationale for storing the full entry as JSON in `payload`: `SessionEntry` is a discriminated union owned by bodhi-pi, and `AgentMessage` (from `pi-agent-core`) is a deep, evolving shape we don't want to mirror column-by-column. JSON keeps the store schema-stable across bodhi-pi minor versions.

### Store (`sessions/sqlite-session-store.ts`)

Implements every method on the `SessionStore` interface from `packages/bodhi-pi/src/sessions/session-store.ts:47-69`:

- **`create({ cwd })`**: insert a new session row with `randomUUID()`, return cloned `SessionRecord` with empty `entries`.
- **`load(sessionId)`**: SELECT session row + all entries ORDER BY ordinal, `JSON.parse` each `payload` back to `SessionEntry`. Return `undefined` if no session row.
- **`append(sessionId, entry)`**: transaction — read max ordinal for the session, insert new entry at `max+1`, `UPDATE sessions SET updated_at = ?`. Throw `Error("session ${sessionId} not found")` if the session row is missing, matching the in-memory store's contract (`in-memory-session-store.ts:40-44`).
- **`list({ cwd, cursor })`**: SELECT WHERE optional `cwd = ?` ORDER BY `updated_at DESC, id DESC` LIMIT 51. Cursor is `base64url(JSON.stringify({ updatedAt, id }))`. The 51st row decides `nextCursor`. `messageCount` is computed via `SELECT count(*) WHERE type='message'` per session — fine at REPL scale.
- **`delete(sessionId)`**: DELETE; the FK `ON DELETE CASCADE` removes entries.

DB path: `~/.bodhi-pi-cli/sessions.db`. The directory is created on first launch. `better-sqlite3` in WAL mode (`pragma journal_mode = WAL`).

### Migrations (`sessions/migrate.ts`)

On startup, after opening the DB, call `migrate(db, { migrationsFolder: <abs path to drizzle/> })` from `drizzle-orm/better-sqlite3/migrator`. Migration files are generated at dev time via `npm run db:generate` (alias for `drizzle-kit generate`) and committed to the package.

`drizzle.config.ts`:
```ts
export default {
  schema: "./src/sessions/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
} satisfies Config;
```

## ACP wiring (in-process)

The in-process pair pattern lives in the bodhi-pi tests. We won't import the test helper (it's not exported); we replicate it inline in `repl/repl.ts`. Reference: `packages/bodhi-pi/test/helpers/in-process-acp.ts` (find via grep — agent calls explored this code path) and the public `AgentSideConnection` + `ndJsonStream` re-exports from `packages/bodhi-pi/src/index.ts:1`.

Lifecycle on each REPL turn:
1. (Once at startup) `clientConn.initialize(stdInitParams)` and `clientConn.newSession({ cwd, mcpServers: [] })`. Cache the `sessionId`.
2. On each user line: `clientConn.prompt({ sessionId, prompt: [{ type: "text", text: line }] })`.
3. While the prompt is in flight, `sessionUpdate` notifications stream into `render.ts`.
4. After the promise resolves, print the stop reason on its own line and re-show the `> ` prompt.

`/new` issues a fresh `newSession`. `/resume <id>` calls the ACP `session/load` extension if the SDK exposes it; otherwise it errors out with "not yet supported" — bodhi-pi's resume path is real (entries replay from the store) but we'll verify the client method name during implementation, not now.

## Renderer (`repl/render.ts`)

Subscribes to the four `sessionUpdate` kinds bodhi-pi emits (see `packages/bodhi-pi/src/acp/agent.ts:307-363`):

- `agent_message_chunk` → write text delta straight to stdout, no newline.
- `tool_call` → newline + `chalk.cyan("⚒ <name>")` + dim args summary.
- `tool_call_update` → newline + `chalk.green("✓")` or `chalk.red("✗")` + truncated result preview (~400 chars).
- `agent_thought_chunk` (if emitted) → dim grey delta.

Plain `chalk` is the only rendering dep; no `pi-tui`. Hand-rolled means hand-rolled.

## Config resolution (`config.ts`)

```ts
resolveConfig({ argv }) -> {
  models: Model<Api>[],          // from @mariozechner/pi-ai built-in registry
  defaultModelId: string,
  getApiKey: (provider) => process.env[`${provider.toUpperCase()}_API_KEY`],
  systemPrompt?: string,         // from --system-prompt or BODHI_SYSTEM_PROMPT
  dbPath: string,                // ~/.bodhi-pi-cli/sessions.db, override via --db
}
```

Model selection precedence: `--model` flag > `BODHI_MODEL` env > first model in the registry whose provider has an API key set. If none has a key, exit with a clear error listing the env vars we looked for.

CLI flags (minimal, parsed by hand — no `commander`/`yargs` dep):
- `--model <id>`
- `--system-prompt <text>` / `--system-prompt-file <path>`
- `--db <path>`
- `--help`, `--version`

## REPL slash commands

- `/help` — list commands.
- `/new` — start a new ACP session (drops the live one, fresh sessionId).
- `/sessions` — `sessionStore.list({ cwd })`, print id + updatedAt + messageCount.
- `/resume <id>` — load an existing session (calls ACP `session/load`).
- `/model <id>` — change model mid-session via the ACP setSessionModel method (verify exact wire name during implementation — bodhi-pi documents this in `acp/agent.ts`).
- `/quit` or Ctrl-D — close the connection, flush DB, exit 0.

## Tests (designed up front, per `packages/bodhi-pi/CLAUDE.md` testing policy)

**Integration (`test/`, `vitest`)** — primary correctness layer:
- `fs.test.ts`: NodeFilesystem against `os.tmpdir()`. Round-trip read/write, list ordering, mkdir recursive, remove recursive, ENOENT/EISDIR mapping, jail rejection.
- `sessions.test.ts`: SqliteSessionStore against a tmp `.db` file (created and torn down per test). Cover `create → append → load` round-trip, `list({ cwd })` filtering, cursor pagination across 60 rows, `delete` cascade, "session not found" rejection on append.
- `config.test.ts`: model resolution precedence, missing-keys error.

**E2E (`e2e/`, gpt-5-mini only, vitest)** — thin sanity check:
- `repl.e2e.ts`: build the REPL in-process, send one short prompt through `clientConn.prompt`, assert at least one `agent_message_chunk` arrives and the final stop reason is `end_turn`. Skip if `OPENAI_API_KEY` is absent.

No mocking of bodhi-pi internals; the integration tests target our adapters, the e2e test targets the full wiring.

## Critical files to read while implementing

| Path | Why |
|---|---|
| `packages/bodhi-pi/src/index.ts` | Exact public surface to import. |
| `packages/bodhi-pi/src/acp/agent.ts:44-76` | `BodhiPiConfig` shape and validation. |
| `packages/bodhi-pi/src/acp/agent.ts:307-363` | `sessionUpdate` notification kinds the renderer must handle. |
| `packages/bodhi-pi/src/filesystem/filesystem.ts:12-33` | Filesystem contract. |
| `packages/bodhi-pi/src/sessions/session-store.ts:47-69` | SessionStore contract. |
| `packages/bodhi-pi/test/helpers/harness.ts` | Reference for in-process ACP pair construction. |
| `packages/bodhi-pi/e2e/chat.e2e.ts:9-27` | Reference for `initialize → newSession → prompt` lifecycle. |
| `tsconfig.base.json` | Build config to extend. |
| `biome.json` | Lint/format rules (tabs, width 120). |

## Verification

1. `npm install` at the workspace root picks up the new package.
2. `npm run build -w @bodhiapp/bodhi-pi-cli` — clean `tsgo` build to `dist/`.
3. `npm run test -w @bodhiapp/bodhi-pi-cli` — integration tests pass against tmp dirs.
4. `OPENAI_API_KEY=... npm run test:e2e -w @bodhiapp/bodhi-pi-cli` — gpt-5-mini smoke test passes.
5. Manual: in a scratch repo, run `npx bodhi-pi-cli` with `OPENAI_API_KEY` set, type "list the files here and read README.md if there is one", confirm:
   - tool calls render with name + status,
   - text streams character-by-character,
   - `~/.bodhi-pi-cli/sessions.db` exists and `/sessions` lists the new session,
   - `/quit` exits cleanly with no dangling handles.
6. Open `~/.bodhi-pi-cli/sessions.db` with `sqlite3` and confirm rows in `sessions` and `session_entries`, with `cwd` column set to the launch directory.

## Out of scope (explicit non-goals)

- One-shot non-REPL mode (deferred; trivial to add later by reusing `runRepl` internals).
- Permission prompting UI (auto-approve in v1).
- Stdio ACP transport (deferred; in-process is enough for live testing).
- TUI rendering with `pi-tui` (use plain chalk).
- Publishing to npm (private workspace package only).
- Resuming sessions across schema migrations from older CLI versions (handled when first migration ships).
