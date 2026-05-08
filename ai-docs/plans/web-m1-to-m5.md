# bodhi-pi-browser + bodhi-pi-web — iterative milestone plan

## Context

The repo has a Node-side pair: `@bodhiapp/bodhi-pi-node` (adapter library) feeding `@bodhiapp/bodhi-pi-cli` (CLI host). We want the browser equivalent so the same agent runs in a browser tab without porting agent logic — only host-injected services change shape:

- **`@bodhiapp/bodhi-pi-browser`** (new library, mirrors `bodhi-pi-node`): browser implementations of `Filesystem`, `SessionStore`, `ScriptExecutor`, plus the postMessage transport helper. **Adapters land per-milestone, not all at once.**
- **`@bodhiapp/bodhi-pi-web`** (existing Vite/React/TS scaffold, mirrors `bodhi-pi-cli`): chat UI on the main thread, agent in a Web Worker. Main↔Worker speaks ACP framed over a `MessagePort` (transport pattern lifted from the abandoned `BodhiSearch/pi-mono/packages/web-acp`; we cite it **only** for messaging — none of its agent code is reused).

This plan follows the iterative, evolutionary, test-driven, minimal style of bodhi-pi's M1.x and M2.x milestones (`ai-docs/plans/m1_3-switch-model.md`, `ai-docs/plans/m2_1-basic-session-persistence.md`, `ai-docs/plans/cli-m-1-implement.md`). Each milestone:

- ships the smallest runnable slice
- ends with `npm run check` clean + integration green + e2e green
- ends with a single `feat(bodhi-pi-{web,browser}): land Mx.y …` commit
- defers anything not strictly needed for the slice — interfaces, persistence, sandboxing, sidebar UI, skills, mcpServers all wait until a milestone needs them

## Decisions (locked in via clarifying Q&A)

- **One commit per milestone.** Each milestone ends with a green check + a single feat commit. No sub-commits.
- **No `ScriptExecutor` in M3.** Per `bodhi-pi/CLAUDE.md`, the `run_script` skill registers only when an executor is present — omitting it is the canonical "off" state. M8 lands the browser executor when needed.
- **No sessions sidebar in M5.** Slash commands only (`/sessions`, `/new`, `/resume`, `/close`, `/delete`). Sidebar UI is deferred — slash commands are easier to e2e-test cleanly and match the CLI parity claim.
- **In-memory adapters for M3-M5.** `createInMemoryFilesystem()` + `createInMemorySessionStore()` from `@bodhiapp/bodhi-pi` get reused inside the worker. Sessions vanish on page reload — fine for v1. M6 (Dexie) and M7 (ZenFS) replace them once M1-M5 are proven.
- **Vite dev server on port `35173`** with `--strictPort`. Playwright `webServer.reuseExistingServer: false`. Fail if port busy.
- **`.env` copied from `bodhi-pi-cli/.env`**, keys re-prefixed `VITE_*`. M3 e2e fails fast if `VITE_OPENAI_API_KEY` is missing.
- **All e2e uses `gpt-4o-mini`** (per `feedback_bodhi_pi_e2e_strategy` memory; cheap, non-reasoning, deterministic enough). M4 also uses `gpt-4o` to verify the switch actually routes.
- **Worker file lives in `bodhi-pi-web/src/agent/worker.ts`**, spawned via Vite ESM worker pattern (`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`). bodhi-pi-browser stays a pure adapter library.

## Phase split

| Milestone | Scope | New code | Test gate |
|---|---|---|---|
| **M1** | Bootstrap `bodhi-pi-browser` package | empty package skeleton + `createMessagePortStream` only | unit test for the transport helper |
| **M2** | bodhi-pi-web chat UI shell + Playwright bootstrap | composer, message list, echo-only mock, POM, smoke spec | Playwright spec asserts boot + composer flow against echoed mock |
| **M3** | Worker + ACP wiring + in-memory adapters + hardcoded `gpt-4o-mini` | `worker.ts`, `runtime.ts`, `RuntimeProvider`, env loading, render dispatch | live OpenAI e2e: send prompt → assistant message contains expected substring |
| **M4** | Model registry + `/model` slash command + `/help` | model registry passed to worker init, slash-command handler ported from cli, model selector display | e2e: chat with gpt-4o-mini, `/model gpt-4o`, chat again, both responses arrive |
| **M5** | Session lifecycle slash commands (no sidebar) | `/sessions`, `/new`, `/resume`, `/close`, `/delete` | e2e: multi-session round-trip, history replay on resume, delete removes from list |

After M5: M6 (Dexie session store), M7 (ZenFS filesystem), M8 (browser script executor), M9 (sidebar UI) — planned later, not in this document.

---

## M1 — Bootstrap `@bodhiapp/bodhi-pi-browser`

### Scope

Empty workspace package that builds, tests, and is installable as a dep on `bodhi-pi-web`. Only one piece of real code: `createMessagePortStream` (the transport helper used by both worker and main thread in M3). Everything else (`Filesystem`/`SessionStore`/`ScriptExecutor` factories) waits — those interfaces aren't needed yet, and bodhi-pi already ships in-memory implementations we'll use through M5.

### Files (new)

```
packages/bodhi-pi-browser/
├─ package.json
├─ tsconfig.json
├─ tsconfig.build.json
├─ vitest.config.ts
├─ README.md
└─ src/
   ├─ index.ts                              # exports createMessagePortStream
   └─ transport/
       ├─ message-port-stream.ts            # ported from web-acp's worker-stream.ts
       └─ message-port-stream.test.ts       # unit test (see below)
```

`package.json` (mirrors `packages/bodhi-pi-node/package.json` shape):

```jsonc
{
  "name": "@bodhiapp/bodhi-pi-browser",
  "version": "0.0.1",
  "description": "Browser adapters (ZenFS, Dexie, AsyncFunction) for @bodhiapp/bodhi-pi.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "README.md"],
  "scripts": {
    "clean": "shx rm -rf dist",
    "build": "tsgo -p tsconfig.build.json && tsc-alias -p tsconfig.build.json",
    "dev":   "tsgo -p tsconfig.build.json --watch --preserveWatchOutput",
    "test":  "vitest --run",
    "prepublishOnly": "npm run clean && npm run build"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "^24.3.0",
    "tsc-alias": "^1.8.10",
    "typescript": "^5.7.3",
    "vitest": "^3.2.4"
  }
}
```

No `@bodhiapp/bodhi-pi` dep yet — `createMessagePortStream` doesn't reference it. ZenFS/Dexie deps land in their own milestones.

`src/transport/message-port-stream.ts`:

```ts
export interface PortByteStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/** Wraps a MessagePort into the readable/writable shape ndJsonStream expects. */
export function createMessagePortStream(port: MessagePort): PortByteStream {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      port.onmessage = (event) => {
        const data = event.data;
        if (data instanceof Uint8Array) controller.enqueue(data);
        else if (data instanceof ArrayBuffer) controller.enqueue(new Uint8Array(data));
        else if (typeof data === "string") controller.enqueue(new TextEncoder().encode(data));
      };
      port.onmessageerror = (event) => controller.error(new Error(`MessagePort error: ${String(event.data)}`));
      port.start();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      const out = new Uint8Array(chunk.byteLength);
      out.set(chunk);
      port.postMessage(out, [out.buffer]);
    },
  });
  return { readable, writable };
}
```

Source: `BodhiSearch/pi-mono/packages/web-acp/src/runtime/transport/worker-stream.ts` (copy, no agent code).

### Files (modified)

- Root `package.json` `check` script — append `&& tsgo --noEmit -p packages/bodhi-pi-browser/tsconfig.json`.

### TDD — M1

Single unit test (`src/transport/message-port-stream.test.ts`): use `MessageChannel` (available in vitest's Node environment via `node:worker_threads`'s globalThis exposure or a lightweight polyfill — verify; if missing, the test imports `MessageChannel` from `node:worker_threads`).

```ts
test("round-trips a Uint8Array between two ports", async () => {
  const channel = new MessageChannel();
  const a = createMessagePortStream(channel.port1);
  const b = createMessagePortStream(channel.port2);

  const writer = a.writable.getWriter();
  await writer.write(new TextEncoder().encode("hello"));
  await writer.close();

  const reader = b.readable.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toBe("hello");
});
```

### Verification — M1

```bash
npm install                                           # workspace registers the new package
npm --workspace @bodhiapp/bodhi-pi-browser run build  # tsgo emits dist/
npm --workspace @bodhiapp/bodhi-pi-browser run test   # 1 unit test green
npm run check                                         # clean
```

### Acceptance gate — M1

`@bodhiapp/bodhi-pi-browser` is buildable, testable, installable. `createMessagePortStream` round-trips bytes between two ports.

### Commit

`feat(bodhi-pi-browser): bootstrap package with createMessagePortStream`

---

## M2 — bodhi-pi-web chat UI shell + Playwright bootstrap

### Scope

Replace the Vite template with a real chat UI — composer, message list, status bar — backed by an **echo-only mock**. No worker, no ACP, no agent. The point of M2 is to lock the UI testability contract (`data-testid` / `data-test-state`) and prove Playwright can drive it on port 35173. M3 plugs the agent in behind the same UI.

### Files (new)

```
packages/bodhi-pi-web/
├─ playwright.config.ts                       # port 35173, strictPort, fail if busy
├─ .env.example                               # VITE_OPENAI_API_KEY=
├─ src/
│   ├─ ui/
│   │   ├─ ChatPage.tsx
│   │   ├─ MessageList.tsx
│   │   ├─ Composer.tsx
│   │   └─ StatusBar.tsx
│   └─ store/chatStore.ts                     # Zustand: messages[], status
└─ e2e/
    ├─ fixtures.ts                            # extends test with ChatPage POM
    ├─ pages/ChatPage.ts                      # POM
    └─ chat.spec.ts                           # echo round-trip smoke
```

### Files (modified)

- `packages/bodhi-pi-web/package.json` — add `@playwright/test`, `dotenv`, `zustand`; replace `dev`/`build`/`preview` scripts to use `--port 35173 --strictPort`; add `test:e2e`.
- `packages/bodhi-pi-web/vite.config.ts` — `server: { port: 35173, strictPort: true }`, `worker: { format: 'es' }`.
- `packages/bodhi-pi-web/src/App.tsx`, `src/main.tsx` — replace template with `<ChatPage />`.
- `packages/bodhi-pi-web/.gitignore` — ensure `.env`, `e2e/test-results/`, `playwright-report/` ignored.

### UI testability contract

Locked in M2; M3+ extend the same selectors:

- Outer: `<div data-testid="chat-page" data-test-state={status}>` — `status ∈ "echo" | "initializing" | "idle" | "streaming" | "error"`. (M2 only uses `"echo"`.)
- Status bar: `<div data-testid="status-bar" data-current-model={modelId} data-session-id={sessionId.slice(0,8)}>`. (M2: `modelId="echo"`, `sessionId="local"`.)
- Message list: `<div data-testid="message-list">`; each child `<div data-testid="message" data-message-role="user|assistant|system">`.
- Composer: `<form data-testid="composer">` with `<input data-testid="composer-input">` + `<button data-testid="composer-send">`.

### Mock behavior

Typing "anything" + Enter pushes a `{role:"user"}` message and immediately a `{role:"assistant", content:"echo: anything"}` message. No async, no streaming. Pure UI proving.

### Playwright config (`playwright.config.ts`)

```ts
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  use: { baseURL: "http://localhost:35173", trace: "on-first-retry" },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:35173",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

### POM — `e2e/pages/ChatPage.ts`

```ts
export class ChatPage {
  constructor(public readonly page: Page) {}
  goto = () => this.page.goto("/");
  waitForState = (s: "echo"|"idle"|"streaming") =>
    expect(this.page.getByTestId("chat-page")).toHaveAttribute("data-test-state", s);
  send = async (text: string) => {
    await this.page.getByTestId("composer-input").fill(text);
    await this.page.getByTestId("composer-send").click();
  };
  lastMessage = async (role: "user"|"assistant"|"system") => {
    const all = await this.page.locator(`[data-testid="message"][data-message-role="${role}"]`).all();
    return all.at(-1)?.textContent() ?? "";
  };
}
```

### TDD — M2

`e2e/chat.spec.ts`:

```ts
import { test, expect } from "./fixtures";

test("echo round trip", async ({ chat }) => {
  await test.step("boot", async () => {
    await chat.goto();
    await chat.waitForState("echo");
  });
  await test.step("send", async () => { await chat.send("hello"); });
  await test.step("user message lands", async () => {
    expect(await chat.lastMessage("user")).toBe("hello");
  });
  await test.step("echo response lands", async () => {
    expect(await chat.lastMessage("assistant")).toBe("echo: hello");
  });
});
```

### Verification — M2

```bash
npm --workspace @bodhiapp/bodhi-pi-web run dev          # manual: open http://localhost:35173, type, see echo
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e     # smoke spec green
npm run check
```

### Acceptance gate — M2

UI shell renders; selectors are stable; Playwright drives a round-trip end-to-end against the mock; the dev-server port is locked.

### Commit

`feat(bodhi-pi-web): scaffold chat UI shell with playwright e2e bootstrap`

---

## M3 — Worker + ACP, in-memory adapters, hardcoded `gpt-4o-mini`

### Scope

Replace the M2 echo mock with a real bodhi-pi agent running in a Web Worker. The worker uses the in-memory `Filesystem` and `SessionStore` already shipped by `@bodhiapp/bodhi-pi`. The model registry is a single hardcoded `gpt-4o-mini`. The flow on the main thread:

1. On mount, `RuntimeProvider` spawns the worker, posts `init` with a transferred `MessagePort`, builds a `ClientSideConnection` over `ndJsonStream(createMessagePortStream(port1))`.
2. Calls `conn.initialize(...)` then `conn.newSession({ cwd:"/", mcpServers:[] })`. Stores `sessionId`. Status flips `"initializing"` → `"idle"`.
3. Composer Enter → `conn.prompt({ sessionId, prompt:[{type:"text", text}] })`. Status flips `"streaming"` until promise resolves.
4. `sessionUpdate` notifications stream via the handler → `render.ts` dispatches into the chat store → assistant message accumulates as chunks arrive.

### Architecture delta from M2

```
+-------------------- main thread (Vite dev :35173) ---------------------+
|  <RuntimeProvider> ── startAgentRuntime()                              |
|       worker = new Worker(new URL('./agent/worker.ts', import.meta.url))|
|       channel = new MessageChannel()                                   |
|       worker.postMessage({type:'init', agentPort: port2, ...}, [port2])|
|       conn = new ClientSideConnection(handler, ndJsonStream(port1))    |
|       await conn.initialize(...)                                       |
|       const { sessionId } = await conn.newSession({cwd:'/',...})       |
|  <ChatPage>                                                            |
|       Composer onSubmit → conn.prompt(...)                             |
|       sessionUpdate handler → render.ts → chatStore                    |
+----------------------------┬-------------------------------------------+
                             │ MessagePort (Uint8Array NDJSON frames)
+----------------------------┴-------------------------------------------+
| Worker (src/agent/worker.ts, type:"module")                            |
|   on init:                                                             |
|     filesystem    = createInMemoryFilesystem()  // from @bodhiapp/bodhi-pi |
|     sessionStore  = createInMemorySessionStore()                       |
|     factory       = createBodhiPiAgent({                               |
|         models: [gpt-4o-mini], defaultModelId: "gpt-4o-mini",          |
|         getApiKey: (p) => apiKeys[p],                                  |
|         filesystem, sessionStore,                                      |
|     })                                                                 |
|     new AgentSideConnection(factory, ndJsonStream(port2))              |
+------------------------------------------------------------------------+
```

### Files (new)

```
packages/bodhi-pi-web/src/
├─ env.ts                           # readEnv() → { apiKeys, defaultModelId, models }
├─ agent/
│   ├─ worker.ts                    # ESM worker entry
│   ├─ runtime.ts                   # startAgentRuntime() — spawn + ClientSideConnection
│   ├─ types.ts                     # InitMessage interface
│   └─ render.ts                    # SessionNotification → chatStore actions (port of cli's repl/render.ts)
└─ ui/
    └─ RuntimeProvider.tsx          # context — owns conn, sessionId, currentModelId
```

### Files (modified)

- `packages/bodhi-pi-web/package.json` — add `@agentclientprotocol/sdk`, `@bodhiapp/bodhi-pi`, `@bodhiapp/bodhi-pi-browser`, `@mariozechner/pi-ai`.
- `packages/bodhi-pi-web/src/store/chatStore.ts` — add `appendChunk(role, text)`, `addMessage(role, text)`, `setStatus(s)`.
- `packages/bodhi-pi-web/src/ui/ChatPage.tsx` — wrap with `<RuntimeProvider>`, replace echo handler with `conn.prompt(...)`.
- `packages/bodhi-pi-web/.env.example` — bump with `VITE_OPENAI_API_KEY=`.
- `packages/bodhi-pi-web/src/ui/App.tsx` — `data-test-state` now derives from runtime status.
- ESLint config: `no-restricted-imports` for `@bodhiapp/bodhi-pi-node`, `node:*` from `src/**` (defends against accidental Node-only deps in the bundle).
- Root `package.json` `check` script — append `&& tsgo --noEmit -p packages/bodhi-pi-web/tsconfig.json`.

### `worker.ts` shape

```ts
/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent, createInMemoryFilesystem, createInMemorySessionStore } from "@bodhiapp/bodhi-pi";
import { createMessagePortStream } from "@bodhiapp/bodhi-pi-browser";
import type { InitMessage } from "./types";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", function onInit(ev: MessageEvent<InitMessage>) {
  if (ev.data?.type !== "init") return;
  self.removeEventListener("message", onInit);
  const { agentPort, models, defaultModelId, apiKeys } = ev.data;

  const factory = createBodhiPiAgent({
    models, defaultModelId,
    getApiKey: (p) => apiKeys[p],
    filesystem: createInMemoryFilesystem(),
    sessionStore: createInMemorySessionStore(),
    // scriptExecutor omitted in M3 — run_script skill stays unregistered
  });

  const { readable, writable } = createMessagePortStream(agentPort);
  const conn = new AgentSideConnection(factory, ndJsonStream(writable, readable));
  void conn; // hold ref
});
```

### `runtime.ts` shape

```ts
export async function startAgentRuntime(opts: RuntimeOptions) {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const channel = new MessageChannel();
  worker.postMessage(
    { type:"init", agentPort: channel.port2, models: opts.models, defaultModelId: opts.defaultModelId, apiKeys: opts.apiKeys },
    [channel.port2],
  );
  const { readable, writable } = createMessagePortStream(channel.port1);
  const handler: Client = {
    sessionUpdate: async (n) => opts.onNotification(n),
    requestPermission: async () => ({ outcome: { outcome: "approved" } }),
  };
  const conn = new ClientSideConnection(() => handler, ndJsonStream(writable, readable));
  await conn.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  return { conn, worker };
}
```

### `render.ts` (port of `bodhi-pi-cli/src/repl/render.ts`)

Same parsing logic for `agent_message_chunk` / `tool_call` / `tool_call_update` / `user_message_chunk`, but instead of `process.stdout.write` it dispatches `chatStore.appendChunk(role, text)` etc. Direct line-by-line port; no new behavior.

### TDD — M3

#### E2E (`e2e/chat.spec.ts` extension — replaces M2's echo spec)

Real OpenAI via `VITE_OPENAI_API_KEY`. Single test:

```ts
test("agent round trip with gpt-4o-mini", async ({ chat }) => {
  await test.step("boot to idle", async () => {
    await chat.goto();
    await chat.waitForState("idle");                              // status flips after newSession
    await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o-mini");
  });
  await test.step("send prompt", async () => {
    await chat.send("Reply with the single word: ping");
  });
  await test.step("streaming starts", async () => { await chat.waitForState("streaming"); });
  await test.step("returns to idle", async () => { await chat.waitForState("idle"); });
  await test.step("response contains ping", async () => {
    const text = await chat.lastMessage("assistant");
    expect(text.toLowerCase()).toContain("ping");
  });
});
```

`e2e/fixtures.ts` reads `.env`; if `VITE_OPENAI_API_KEY` missing, throw (loud failure, not skip). Mirrors `bodhi-pi-cli/e2e`.

#### Integration (none in M3)

The agent itself is exhaustively tested in `@bodhiapp/bodhi-pi`. The transport helper is tested in M1. M3 has no new pure-logic surface to integration-test — the e2e exercises the full wiring.

### Verification — M3

```bash
# Copy CLI's .env over (one-time)
cp packages/bodhi-pi-cli/.env packages/bodhi-pi-web/.env
sed -i '' 's/^OPENAI_API_KEY=/VITE_OPENAI_API_KEY=/' packages/bodhi-pi-web/.env
sed -i '' 's/^ANTHROPIC_API_KEY=/VITE_ANTHROPIC_API_KEY=/' packages/bodhi-pi-web/.env

npm --workspace @bodhiapp/bodhi-pi-web run dev          # manual: type "say hi", get response
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e     # 1 e2e test green
npm run check
```

### Acceptance gate — M3

A user types in the browser, the worker streams a response from a real OpenAI model, the UI updates chunk-by-chunk, status transitions are observable in `data-test-state`, e2e is green.

### Commit

`feat(bodhi-pi-web): land M3 — embed bodhi-pi in worker with in-memory adapters`

---

## M4 — Model registry + `/model` slash command

### Scope

The agent already exposes a model selector via `session/setSessionConfigOption` (bodhi-pi M1.3). M4 lights up the client side:

1. Worker init message carries a multi-model registry (`gpt-4o-mini`, `gpt-4o`).
2. After `newSession`, the main thread reads `configOptions[0]` (the model selector) and renders `currentValue` into the status bar; full options list available for `/model`.
3. Slash-command handler ported from `packages/bodhi-pi-cli/src/repl/commands.ts` (drop `/quit`, drop session-related commands — those land in M5). M4 ships `/help` and `/model` only.
4. Routing rule from `bodhi-pi-cli/src/repl/repl.ts:90-101`: if `line.startsWith("/")` and the cmd isn't in `state.availableCommands`, run locally; otherwise forward as a `prompt`.

### Files (new)

```
packages/bodhi-pi-web/src/ui/
└─ commands.ts                # local slash-command dispatcher (M4: /help, /model)
```

### Files (modified)

- `packages/bodhi-pi-web/src/env.ts` — `models` returns `[gpt-4o-mini, gpt-4o]` from `pi-ai`'s registry.
- `packages/bodhi-pi-web/src/agent/worker.ts` — accept `models` from `InitMessage` (already in shape from M3).
- `packages/bodhi-pi-web/src/ui/RuntimeProvider.tsx` — store `availableCommands` (from `available_commands_update` notifications), expose `runCommand(line)`.
- `packages/bodhi-pi-web/src/ui/ChatPage.tsx` — composer Enter routes through `runCommand` for `/`-prefixed input; updates status bar's `data-current-model` after `setSessionConfigOption`.
- `packages/bodhi-pi-web/src/store/chatStore.ts` — add `addSystemMessage(text)` for command output.

### Slash-command surface

Direct port (minus session commands and `/quit`):

| Command | Action | Surfacing |
|---|---|---|
| `/help` | Print available local commands + agent-announced commands | system message |
| `/model` (no arg) | Print current model + list of options | system message |
| `/model <id>` | `conn.setSessionConfigOption({ sessionId, configId:"model", value:id })`; on success, update `currentModelId` from response | system message + status bar `data-current-model` flips |

Errors (unknown id, unknown command) surface as `{role:"system"}` messages rendered with a distinct style — Playwright reads them via `[data-message-role="system"]`.

### TDD — M4

#### E2E (`e2e/model-switch.spec.ts`)

```ts
test("multi-model switching with /model", async ({ chat }) => {
  await test.step("boot defaults to gpt-4o-mini", async () => {
    await chat.goto();
    await chat.waitForState("idle");
    await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o-mini");
  });
  await test.step("first turn against gpt-4o-mini", async () => {
    await chat.send("Reply with the single word: alpha");
    await chat.waitForState("idle");
    expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("alpha");
  });
  await test.step("/model gpt-4o switches", async () => {
    await chat.send("/model gpt-4o");
    await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o");
  });
  await test.step("second turn routes to gpt-4o", async () => {
    await chat.send("Reply with the single word: beta");
    await chat.waitForState("idle");
    expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("beta");
  });
});
```

We don't assert provenance (gpt-4o-mini vs gpt-4o text differs slightly but unreliably). The behavioural assertion that matters is the status bar attribute flip after `setSessionConfigOption` succeeds.

### Verification — M4

```bash
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e
npm run check
```

### Acceptance gate — M4

User can type `/model gpt-4o` → status bar updates → next prompt routes to the new model. `/help` lists both local and agent-announced commands.

### Commit

`feat(bodhi-pi-web): land M4 — model registry and /model slash command`

---

## M5 — Session lifecycle slash commands

### Scope

Light up the four ACP session methods bodhi-pi already implements (M2.1) via slash commands. **No sidebar UI** — the cli's `commands.ts` patterns map cleanly onto chat-line input.

| Command | ACP call | Notes |
|---|---|---|
| `/sessions` | `conn.listSessions({ cwd })` | renders id-prefix + lastUpdate + messageCount as a system message; mark current session with `*` |
| `/new` | `conn.closeSession(current)` then `conn.newSession({cwd:'/', mcpServers:[]})` | resets `currentModelId` to default; adds `data-test-state="idle"` flip |
| `/resume <id>` | `conn.loadSession({sessionId, cwd:'/', mcpServers:[]})` | bodhi-pi streams `user_message_chunk` + `agent_message_chunk` notifications during the call; chat list rebuilds from those notifications |
| `/close` | `conn.closeSession({sessionId: current})` | drops the live agent in worker; data persists in store; UI flips to `"closed"` state, composer disabled until `/new` or `/resume` |
| `/delete <id>` | `conn.extMethod("_bodhi-pi/session/delete", { sessionId })` | terminal removal; if `id === current`, immediately call `/new` |

### Files (modified)

- `packages/bodhi-pi-web/src/ui/commands.ts` — add the five handlers; lift logic from `packages/bodhi-pi-cli/src/repl/commands.ts` (specifically the `/new`, `/sessions`, `/resume`, `/close`, `/delete` cases). Output goes to `addSystemMessage`, not `process.stdout.write`.
- `packages/bodhi-pi-web/src/agent/render.ts` — handle `user_message_chunk` (M2.1 only emits this during loadSession replay) — append to chat as `{role:"user"}`. M3 already handles `agent_message_chunk`.
- `packages/bodhi-pi-web/src/ui/RuntimeProvider.tsx` — expose `sessionId`, allow `setSessionId` after `/new`/`/resume`. On `/close`, set `status="closed"`; composer disables (`<input disabled data-testid="composer-input">` — Playwright POM gets a `isComposerEnabled()` helper).
- `packages/bodhi-pi-web/src/store/chatStore.ts` — add `clear()` for session swap.

The UI testability contract gains one new state value: `data-test-state="closed"`.

### TDD — M5

#### E2E (`e2e/sessions.spec.ts`)

One spec, multi-step:

```ts
test("session lifecycle via slash commands", async ({ chat }) => {
  await test.step("session A: prompt with a fact", async () => {
    await chat.goto(); await chat.waitForState("idle");
    await chat.send("Remember the codeword 'aurora'. Reply only with: noted");
    await chat.waitForState("idle");
    expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("noted");
  });

  let sessionA: string;
  await test.step("/sessions includes A", async () => {
    await chat.send("/sessions");
    const sys = await chat.lastMessage("system");
    expect(sys).toMatch(/\* [0-9a-f]{8}/);                     // current marker
    sessionA = sys.match(/\* ([0-9a-f]+)/)![1];
  });

  await test.step("/new starts session B", async () => {
    await chat.send("/new");
    await chat.waitForState("idle");
    // Composer is empty; chat list cleared
    expect(await chat.locator(`[data-testid="message"][data-message-role="assistant"]`).count()).toBe(0);
  });

  await test.step("/resume A replays history", async () => {
    await chat.send(`/resume ${sessionA}`);
    await chat.waitForState("idle");
    // Two messages from replay: user 'Remember the codeword aurora...' + assistant 'noted'
    const userMsgs = await chat.locator(`[data-message-role="user"]`).allTextContents();
    expect(userMsgs.some((m) => m.includes("aurora"))).toBe(true);
    const asstMsgs = await chat.locator(`[data-message-role="assistant"]`).allTextContents();
    expect(asstMsgs.some((m) => m.toLowerCase().includes("noted"))).toBe(true);
  });

  await test.step("after resume, context is alive", async () => {
    await chat.send("What was the codeword? Reply with just the word.");
    await chat.waitForState("idle");
    expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("aurora");
  });

  await test.step("/close disables composer", async () => {
    await chat.send("/close");
    await chat.waitForState("closed");
    await expect(chat.input).toBeDisabled();
  });

  await test.step("/delete removes from /sessions", async () => {
    await chat.send("/new");                                   // re-enable input
    await chat.waitForState("idle");
    await chat.send(`/delete ${sessionA}`);
    await chat.send("/sessions");
    const sys = await chat.lastMessage("system");
    expect(sys).not.toContain(sessionA.slice(0, 8));
  });
});
```

This single spec exercises: persistence, list, close (with data preserved), resume + history replay, post-resume context retention, delete. ~7 logical steps under one test fixture — matches the bodhi-pi M2.1 e2e shape (`packages/bodhi-pi/e2e/chat.e2e.ts`).

### Verification — M5

```bash
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e   # 3 e2e specs total green (M3, M4, M5)
npm run check
```

### Acceptance gate — M5

Five lifecycle commands work end-to-end against real `gpt-4o-mini`. Session history survives `/close` → `/resume`. Delete is terminal. Composer disables on `/close`.

### Commit

`feat(bodhi-pi-web): land M5 — session lifecycle slash commands`

---

## Out of scope (deferred to later milestones)

| Concern | Lands in |
|---|---|
| Persistent `SessionStore` (Dexie + IndexedDB; survives reload) | M6 — adds `createDexieSessionStore` to `bodhi-pi-browser`, swaps in worker; e2e: reload page, sessions still listed |
| Persistent `Filesystem` (ZenFS InMemory, then optionally OPFS) | M7 — adds `createZenfsFilesystem` to `bodhi-pi-browser`; e2e: agent writes a file, list shows it |
| Browser `ScriptExecutor` (`AsyncFunction`-based) | M8 — adds `createBrowserScriptExecutor` to `bodhi-pi-browser`; e2e: agent runs a `.js` script via `run_script` |
| Sessions sidebar UI | M9 — visual click-to-load; `/sessions` slash command stays for keyboard parity |
| Skills directory bootstrapping in browser | M10 — host loads skills from a project virtual mount |
| MCP servers (currently `mcpServers: []`) | M11 — connect to remote MCP over WebSocket |
| Auth / permissions UI (currently auto-approve) | M12 — wire `requestPermission` to a modal |
| Live-streaming tool-call updates rendering | follow-up to M3 once tools are visible in real prompts |
| Mobile / responsive layout | post-v1 polish |

## Critical files referenced

Source patterns to reuse (do not modify):

- `packages/bodhi-pi/src/index.ts` — re-exports `createInMemoryFilesystem`, `createInMemorySessionStore`, `createBodhiPiAgent`.
- `packages/bodhi-pi/src/acp/agent.ts` — agent factory, capabilities, lifecycle.
- `packages/bodhi-pi/src/sessions/in-memory-session-store.ts` — used directly in worker M3-M5.
- `packages/bodhi-pi/src/filesystem/in-memory-filesystem.ts` — used directly in worker M3-M5.
- `packages/bodhi-pi-cli/src/agent.ts` — model for `createBrowserAgent`/runtime options shape.
- `packages/bodhi-pi-cli/src/repl/repl.ts:32-122` — model for runtime wiring + cmd-vs-prompt routing.
- `packages/bodhi-pi-cli/src/repl/commands.ts` — direct port to `bodhi-pi-web/src/ui/commands.ts` (M4 + M5).
- `packages/bodhi-pi-cli/src/repl/render.ts` — direct port to `bodhi-pi-web/src/agent/render.ts` (M3+).
- `packages/bodhi-pi/test/helpers/notifications.ts`, `acp-narrow.ts` — patterns for narrowing `SessionNotification` updates.

External reference (transport pattern only — copy, don't import):

- `BodhiSearch/pi-mono/packages/web-acp/src/runtime/transport/worker-stream.ts` — source for `createMessagePortStream` (M1).

## Risks (per milestone)

- **M1**: `MessageChannel` availability in vitest. Resolution: import from `node:worker_threads` if globalThis lacks it.
- **M2**: Vite port conflict with another local app. Resolution: `--strictPort` makes failure loud — fix by killing the conflict, never reuse.
- **M3**: `pi-ai`/`pi-agent-core` referencing `process.env.*` in the worker bundle. Resolution: `vite.config.ts` `define: { 'process.env.NODE_ENV': JSON.stringify(...) }`; expand if a runtime error names another var.
- **M3**: `@bodhiapp/bodhi-pi-node` accidentally pulled into the browser bundle. Resolution: ESLint `no-restricted-imports` + extend root `scripts/check-browser-smoke.mjs` to scan `bodhi-pi-web/src/**`.
- **M4**: `gpt-4o` rate limits or unexpected refusal. Resolution: prompt is "Reply with the single word: beta" — deterministic; if flaky, swap to a second model in the same family (e.g. `gpt-4o-mini` + `gpt-4.1-mini`).
- **M5**: `loadSession` notification ordering. bodhi-pi M2.1 emits `user_message_chunk` then `agent_message_chunk` per persisted message in order — our render dispatch must replay in arrival order, not by role. Already handled by `render.ts`'s sequential dispatch.

## After approval — durable preferences to save (project-feedback memory)

After M5 lands, save:
- bodhi-pi-web mirrors bodhi-pi-cli command set; `/model`, `/sessions`, `/new`, `/resume`, `/close`, `/delete` resolve via the **client side** before being forwarded as a prompt. `/help` lists local + agent-announced together.
- bodhi-pi-web e2e uses real `gpt-4o-mini` per the existing strategy (single cheap OpenAI model). M4 also uses `gpt-4o`. No mocking of LLM responses in e2e.
- The browser package (`@bodhiapp/bodhi-pi-browser`) lands incrementally per milestone — never as one big-bang; each new adapter (`createMessagePortStream` M1, `createDexieSessionStore` M6, `createZenfsFilesystem` M7, `createBrowserScriptExecutor` M8) ships only when its consuming milestone needs it.
- Vite dev server for bodhi-pi-web is locked to port `35173 --strictPort`. Playwright `reuseExistingServer: false`. Fail loudly on conflicts.
