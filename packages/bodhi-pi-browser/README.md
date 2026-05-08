# @bodhiapp/bodhi-pi-browser

Browser runtime adapters for [`@bodhiapp/bodhi-pi`](../bodhi-pi).

`bodhi-pi` core is runtime-agnostic — hosts inject `Filesystem`, `SessionStore`, and `ScriptExecutor` implementations. This package provides browser-side helpers, landing incrementally per milestone:

| Milestone | Helper | Purpose |
|---|---|---|
| **M1** | `createMessagePortStream(port)` | Wraps a `MessagePort` into the `{ readable, writable }` shape ACP's `ndJsonStream` expects. Used on both worker and main-thread sides. |
| M6 | `createDexieSessionStore({ dbName })` | `SessionStore` backed by IndexedDB via Dexie. *(planned)* |
| M7 | `createZenfsFilesystem({ root })` | `Filesystem` backed by ZenFS (in-memory, optionally OPFS). *(planned)* |
| M8 | `createBrowserScriptExecutor({ filesystem })` | `ScriptExecutor` using `AsyncFunction`. *(planned)* |

## Install

```sh
npm install @bodhiapp/bodhi-pi @bodhiapp/bodhi-pi-browser
```

## ACP transport over postMessage

```ts
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createMessagePortStream } from "@bodhiapp/bodhi-pi-browser";

const channel = new MessageChannel();
worker.postMessage({ type: "init", agentPort: channel.port2 }, [channel.port2]);

const { readable, writable } = createMessagePortStream(channel.port1);
const conn = new ClientSideConnection(() => handler, ndJsonStream(writable, readable));
```

The worker mirrors the same wrapper around `port2` and feeds `AgentSideConnection`.
