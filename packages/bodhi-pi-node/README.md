# @bodhiapp/bodhi-pi-node

Node runtime adapters for [`@bodhiapp/bodhi-pi`](../bodhi-pi).

`bodhi-pi` core is runtime-agnostic — hosts inject `Filesystem`, `SessionStore`, and `ScriptExecutor` implementations. This package provides ready-made Node implementations:

| Factory | Implements | Backed by |
|---|---|---|
| `createNodeFilesystem(rootCwd)` | `Filesystem` | `node:fs/promises` (jail-to-cwd) |
| `createNodeScriptExecutor()` | `ScriptExecutor` | `node:child_process` |
| `createSqliteSessionStore(dbPath)` | `SessionStore` | `better-sqlite3` + `drizzle-orm` |
| `defaultDbPath(appDirName?)` | helper | returns `~/.<appDirName>/sessions.db` |

## Install

```sh
npm install @bodhiapp/bodhi-pi @bodhiapp/bodhi-pi-node
```

## Usage

```ts
import { createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import {
  createNodeFilesystem,
  createNodeScriptExecutor,
  createSqliteSessionStore,
  defaultDbPath,
} from "@bodhiapp/bodhi-pi-node";

const factory = createBodhiPiAgent({
  models, defaultModelId, getApiKey,
  filesystem:     createNodeFilesystem(process.cwd()),
  sessionStore:   createSqliteSessionStore(defaultDbPath("my-app")),
  scriptExecutor: createNodeScriptExecutor(),
});
```

## Notes

`better-sqlite3` is a native (node-gyp prebuilt) dependency. Bundlers targeting AWS Lambda, edge runtimes, or other non-Node hosts should be aware — for browser/Chrome hosts, see the upcoming `@bodhiapp/bodhi-pi-chrome` (OPFS + IndexedDB).
