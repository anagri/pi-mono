# Extract Node adapters into `@bodhiapp/bodhi-pi-node`

## Context

`@bodhiapp/bodhi-pi` is the embeddable, host-mediated, ACP-speaking coding agent. By design, it ships interface-only definitions for `Filesystem`, `SessionStore`, and `ScriptExecutor` (with reference in-memory implementations) and never imports `node:fs`, `better-sqlite3`, or any other runtime adapter — hosts inject those at construction time. This keeps core runtime-agnostic so a future browser/Chrome host can consume it without dragging Node-only deps into its bundle (`bodhi-pi/CLAUDE.md`: *"No fs/file-walk in core"*).

Today, the only Node adapter implementations live inside `@bodhiapp/bodhi-pi-cli`:

- `src/fs/node-filesystem.ts` — `Filesystem` impl on `node:fs/promises` with jail-to-cwd
- `src/fs/node-script-executor.ts` — `ScriptExecutor` impl on `node:child_process`
- `src/sessions/sqlite-session-store.ts` + drizzle schema/migrations — `SessionStore` impl on `better-sqlite3` + `drizzle-orm`

These are valuable to any Node host (a future server host, a different CLI, a desktop wrapper). Locking them inside `bodhi-pi-cli` makes the CLI both *the* REPL host and *the* implicit owner of every Node adapter — which conflates "demo CLI" with "reusable runtime library."

**Goal:** Extract the three Node adapters (plus drizzle assets) into a new workspace package `@bodhiapp/bodhi-pi-node`. `bodhi-pi-cli` shrinks to a pure REPL host that depends on both `@bodhiapp/bodhi-pi` (for the agent/types) and `@bodhiapp/bodhi-pi-node` (for the adapter factories). `@bodhiapp/bodhi-pi` core remains free of sqlite/drizzle/etc. A future `@bodhiapp/bodhi-pi-chrome` (OPFS + IndexedDB) will follow the same pattern and is **out of scope** for this work.

**Why a separate package, not a subpath export `@bodhiapp/bodhi-pi/node`:** Subpath exports with `peerDependencies`/`optionalDependencies` either spam every browser/server consumer with "missing peer better-sqlite3" warnings or silently install a native dep into bundles that don't need it. A separate package keeps each runtime's dep graph clean. This mirrors `@hono/node-server`, `@auth/drizzle-adapter`, `@trpc/server-adapters-*`.

## Decisions (confirmed with user)

- Package name: **`@bodhiapp/bodhi-pi-node`**.
- `defaultDbPath` becomes **parameterized**: `defaultDbPath(appDirName = "bodhi-pi"): string`. CLI calls `defaultDbPath("bodhi-pi-cli")` to preserve `~/.bodhi-pi-cli/sessions.db`.
- Internal layout **mirrors core**: `src/filesystem/`, `src/script-executor/`, `src/sessions/`.
- `@bodhiapp/bodhi-pi` is a regular `dependency` of `-node` (not peer) — interface re-use, no instance/singleton risk. Lockstep semver pin via existing `scripts/sync-versions.js`.

## Target layout

```
packages/bodhi-pi-node/
  package.json
  tsconfig.build.json
  vitest.config.ts
  drizzle.config.ts
  drizzle/
    0000_sessions_table.sql
    meta/_journal.json
  src/
    index.ts
    filesystem/node-filesystem.ts
    script-executor/node-script-executor.ts
    sessions/{sqlite-session-store.ts, schema.ts, migrate.ts}
  test/
    node-filesystem.test.ts
    sqlite-session-store.test.ts
  README.md
```

Public surface (`src/index.ts`):

```ts
export { createNodeFilesystem } from "./filesystem/node-filesystem.js";
export { createNodeScriptExecutor } from "./script-executor/node-script-executor.js";
export { createSqliteSessionStore, defaultDbPath } from "./sessions/sqlite-session-store.js";
```

Do **not** re-export interfaces (`Filesystem`, `SessionStore`, etc.) — they live in `@bodhiapp/bodhi-pi`. Do **not** export `runMigrations` or `schema` — internal.

## File map

| From `bodhi-pi-cli/` | To `bodhi-pi-node/` | Notes |
|---|---|---|
| `src/fs/node-filesystem.ts` | `src/filesystem/node-filesystem.ts` | Body unchanged; type imports from `@bodhiapp/bodhi-pi` already correct |
| `src/fs/node-script-executor.ts` | `src/script-executor/node-script-executor.ts` | Body unchanged |
| `src/sessions/sqlite-session-store.ts` | `src/sessions/sqlite-session-store.ts` | Body unchanged except `defaultDbPath` signature change |
| `src/sessions/schema.ts` | `src/sessions/schema.ts` | Unchanged |
| `src/sessions/migrate.ts` | `src/sessions/migrate.ts` | Unchanged — `../../drizzle` resolution still correct from new home |
| `drizzle/` (entire dir) | `drizzle/` | `git mv` to preserve history |
| `drizzle.config.ts` | `drizzle.config.ts` | Content identical |
| `test/fs.test.ts` | `test/node-filesystem.test.ts` | Update import path: `../src/fs/` → `../src/filesystem/` |
| `test/sessions.test.ts` | `test/sqlite-session-store.test.ts` | Import path stays `../src/sessions/sqlite-session-store.js` |

Stays in `bodhi-pi-cli`: `src/cli.ts`, `src/agent.ts` (rewritten — see below), `src/config.ts` (one import line changes), `src/repl/**`, `test/agent.test.ts`, `test/config.test.ts`, `test/helpers/**`, all of `e2e/**`.

## Critical files to modify

- `/Users/amir36/Documents/workspace/src/github.com/anagri/pi-mono/packages/bodhi-pi-cli/src/agent.ts` — three import lines change
- `/Users/amir36/Documents/workspace/src/github.com/anagri/pi-mono/packages/bodhi-pi-cli/src/config.ts` — `defaultDbPath` import + parameterized call site
- `/Users/amir36/Documents/workspace/src/github.com/anagri/pi-mono/packages/bodhi-pi-cli/package.json` — drop sqlite/drizzle deps; add `@bodhiapp/bodhi-pi-node`; drop `db:generate`, `drizzle.config.ts`, `drizzle/` from `files`
- `/Users/amir36/Documents/workspace/src/github.com/anagri/pi-mono/packages/bodhi-pi-cli/vitest.config.ts` — add source alias for `@bodhiapp/bodhi-pi-node`
- `/Users/amir36/Documents/workspace/src/github.com/anagri/pi-mono/packages/bodhi-pi-cli/drizzle.config.ts` — delete (moved)

New files: everything under `packages/bodhi-pi-node/` (skeleton + moved files).

## Reusable helpers / pre-existing patterns

- Existing source-alias trick in `packages/bodhi-pi-cli/vitest.config.ts` for `@bodhiapp/bodhi-pi` → reuse the same shape for the new `@bodhiapp/bodhi-pi-node` alias.
- Existing `migrate.ts` `import.meta.url` + `path.resolve(here, "../../drizzle")` resolution — works identically in the new package because `drizzle/` sits sibling to `src/` and `dist/` (verified by current behavior in cli).
- Existing `scripts/sync-versions.js` lockstep versioning automatically picks up `packages/*` — no manual change needed.
- Existing `tsconfig.build.json` shape in `bodhi-pi-cli` (extends `../../tsconfig.base.json`) → copy verbatim into `bodhi-pi-node`.
- `package.json` boilerplate (scripts: `clean`, `build`, `dev`, `test`, `prepublishOnly`; `files`, `engines`, `repository`) → mirror `bodhi-pi`'s template.

## `package.json` for the new package

```jsonc
{
  "name": "@bodhiapp/bodhi-pi-node",
  "version": "0.0.1",
  "description": "Node adapters (fs, child_process, better-sqlite3) for @bodhiapp/bodhi-pi.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "drizzle", "README.md"],
  "scripts": {
    "clean": "shx rm -rf dist",
    "build": "tsgo -p tsconfig.build.json",
    "dev":   "tsgo -p tsconfig.build.json --watch --preserveWatchOutput",
    "db:generate": "drizzle-kit generate",
    "test":  "vitest --run",
    "prepublishOnly": "npm run clean && npm run build"
  },
  "dependencies": {
    "@bodhiapp/bodhi-pi": "^0.0.1",
    "better-sqlite3": "^11.10.0",
    "drizzle-orm": "^0.43.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^24.3.0",
    "drizzle-kit": "^0.31.0",
    "typescript": "^5.7.3",
    "vitest": "^3.2.4"
  },
  "engines": { "node": ">=20.0.0" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/anagri/pi-mono.git",
    "directory": "packages/bodhi-pi-node"
  }
}
```

## `bodhi-pi-cli/src/agent.ts` after rewrite

```ts
import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent, type Filesystem, type SessionStore } from "@bodhiapp/bodhi-pi";
import {
  createNodeFilesystem,
  createNodeScriptExecutor,
  createSqliteSessionStore,
} from "@bodhiapp/bodhi-pi-node";
import type { Api, Model } from "@mariozechner/pi-ai";

// CliAgentOptions, CliAgent, createCliAgent body unchanged
```

## `bodhi-pi-cli/src/config.ts` change

```ts
// before: import { defaultDbPath } from "./sessions/sqlite-session-store.js";
import { defaultDbPath } from "@bodhiapp/bodhi-pi-node";

// at the call site:
const dbPath = args.db ?? defaultDbPath("bodhi-pi-cli");
```

## `defaultDbPath` signature update inside the new package

```ts
import os from "node:os";
import path from "node:path";

export function defaultDbPath(appDirName = "bodhi-pi"): string {
  return path.join(os.homedir(), `.${appDirName}`, "sessions.db");
}
```

## `bodhi-pi-cli/package.json` after-state

- Drop `dependencies`: `better-sqlite3`, `drizzle-orm`.
- Drop `devDependencies`: `@types/better-sqlite3`, `drizzle-kit`.
- Add `dependencies`: `"@bodhiapp/bodhi-pi-node": "^0.0.1"`.
- Drop `"drizzle"` from `files`.
- Drop `"db:generate"` script.

## `bodhi-pi-node/vitest.config.ts`

Source-alias `@bodhiapp/bodhi-pi` to its workspace `src/index.ts` so the new package's tests run against core source, matching `bodhi-pi-cli`'s existing pattern:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
const here = path.dirname(fileURLToPath(import.meta.url));
const bodhiPiSrc = path.resolve(here, "../bodhi-pi/src/index.ts");
export default defineConfig({
  resolve: { alias: [{ find: /^@bodhiapp\/bodhi-pi$/, replacement: bodhiPiSrc }] },
  test: {
    globals: true, environment: "node", testTimeout: 30000,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
```

## `bodhi-pi-cli/vitest.config.ts` addition

Add a fourth alias entry:

```ts
{ find: /^@bodhiapp\/bodhi-pi-node$/, replacement: path.resolve(here, "../bodhi-pi-node/src/index.ts") }
```

Without this, cli tests would silently load *built* `dist/index.js` instead of source.

## Step-by-step migration

Execute in order; each step independently verifiable.

1. **Scaffold** `packages/bodhi-pi-node/`: `package.json`, `tsconfig.build.json` (copy cli's verbatim), `README.md` stub, empty `src/index.ts`. Run `npm install` at repo root — verifies workspace registration.
2. **`git mv` source files** per file map. Imports inside the moved files already reference `@bodhiapp/bodhi-pi` for types — no body edits required.
3. **`git mv` drizzle assets**: `drizzle/` dir + `drizzle.config.ts` from cli to new package.
4. **Write `bodhi-pi-node/src/index.ts`** with the three factory exports + `defaultDbPath`.
5. **Update `defaultDbPath` signature** in `sqlite-session-store.ts` to accept `appDirName = "bodhi-pi"`.
6. **Write `bodhi-pi-node/vitest.config.ts`** with the source-alias for `@bodhiapp/bodhi-pi`.
7. **`git mv` tests**: `test/fs.test.ts` → `test/node-filesystem.test.ts` (update `../src/fs/` → `../src/filesystem/` in import); `test/sessions.test.ts` → `test/sqlite-session-store.test.ts`.
8. **Edit `bodhi-pi-cli/package.json`**: drop sqlite/drizzle deps, add `@bodhiapp/bodhi-pi-node`, drop `drizzle` from `files`, drop `db:generate` script.
9. **Edit `bodhi-pi-cli/src/agent.ts`** and **`src/config.ts`**: rewrite imports per snippets above. Update `defaultDbPath` call site to pass `"bodhi-pi-cli"`.
10. **Edit `bodhi-pi-cli/vitest.config.ts`**: add `@bodhiapp/bodhi-pi-node` source alias.
11. **`npm install` at root** — workspace symlink wires `bodhi-pi-cli` → `bodhi-pi-node`.
12. **Update root `package.json` `build` script** (optional but recommended for CI parity): include `bodhi-pi && bodhi-pi-node && bodhi-pi-cli` in the build chain — pre-existing chain skips them, this is a hygiene improvement, mention in commit but don't make it the focus.
13. **Delete empty dirs**: `bodhi-pi-cli/src/fs/`, `bodhi-pi-cli/src/sessions/`.
14. **Update `bodhi-pi-cli/README.md`** one-line note: "Sessions and filesystem adapters live in `@bodhiapp/bodhi-pi-node`." Write `bodhi-pi-node/README.md` with a short blurb describing the three factories and the native-dep caveat (`better-sqlite3` is a node-gyp prebuilt — bundlers targeting Lambda/edge should be aware).

## Verification

End-to-end smoke after every step block:

```bash
# Per-package builds
npm --workspace @bodhiapp/bodhi-pi-node run build
npm --workspace @bodhiapp/bodhi-pi-cli  run build

# Adapter unit tests (new package)
npm --workspace @bodhiapp/bodhi-pi-node run test

# CLI integration (agent.test.ts + config.test.ts)
npm --workspace @bodhiapp/bodhi-pi-cli  run test

# CLI e2e (fs.e2e, repl.e2e, scripts.e2e, sessions.e2e — exercise full wiring incl. sqlite + child_process)
OPENAI_API_KEY=… npm --workspace @bodhiapp/bodhi-pi-cli run test:e2e

# Full sweep
npm run check                 # biome + tsgo --noEmit + browser smoke
npm test                      # all workspaces
```

A green run on all of these — especially `bodhi-pi-cli`'s e2e suite, which already covers spawn, sqlite session round-trip, and fs jail end-to-end via ACP — proves the extraction is behavior-preserving. The cli's existing e2e tests deliberately don't get duplicated in the new package; they already exercise the same code paths through real wiring, which is more valuable than re-testing the adapters in isolation.

## Risks & gotchas

- **`better-sqlite3` is native (node-gyp prebuilt).** Install behavior is unchanged; npm hoists the prebuilt binary into the new package's `node_modules` (or root). Document in `bodhi-pi-node/README.md` so consumers targeting Lambda/edge bundlers are warned.
- **Lockstep versioning.** `scripts/sync-versions.js` picks up `packages/*` automatically. `bodhi-pi-cli` is currently at `0.0.1` while root is `0.0.3` — pre-existing skew, unrelated. Set new package to `0.0.1` to match its only consumer; next `version:patch` lockstep-bumps all three.
- **Vitest source-alias for `@bodhiapp/bodhi-pi-node` is mandatory** in `bodhi-pi-cli/vitest.config.ts`. Without it, cli tests load stale `dist/` artifacts of the new package and silently mask source bugs.
- **`drizzle.config.ts` and `db:generate` move with the schema.** The cli's drizzle config and script must be deleted in the same commit as the schema move, otherwise `db:generate` in the cli breaks confusingly.
- **Migration path resolution** (`migrate.ts` resolves `../../drizzle` from `dist/sessions/migrate.js`) works identically in the new package because the package layout keeps `drizzle/` sibling to `src/` and `dist/`. Verified.
- **Root `prepublishOnly` and `publish`** use `-ws` — the new package joins the publish set automatically. Ensure the new `package.json` includes `"prepublishOnly": "npm run clean && npm run build"`.

## Future-proofing for `@bodhiapp/bodhi-pi-chrome`

Out of scope. The chosen pattern (separate package per runtime, regular dep on core, mirror-of-core internal layout) extends to a Chrome package with no re-architecture: a future `packages/bodhi-pi-chrome/` exports `createOpfsFilesystem`, `createIndexedDbSessionStore`, no `script-executor` (or a worker-based stub), and depends on `@bodhiapp/bodhi-pi` exactly the same way. Browser hosts then `npm i @bodhiapp/bodhi-pi @bodhiapp/bodhi-pi-chrome` and never see `better-sqlite3` in their tree.
