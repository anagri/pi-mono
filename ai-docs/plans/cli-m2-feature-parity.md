# Plan: CLI Test Correctness + Feature-Parity Tests

## Context

`bodhi-pi-cli/e2e/repl.e2e.ts` creates `createBodhiPiAgent` with **in-memory** stubs (`createInMemoryFilesystem`, `createInMemorySessionStore`) — not the CLI's real implementations. The CLI wires `createNodeFilesystem` + `createSqliteSessionStore` + `createNodeScriptExecutor`. The e2e test can pass while all three are broken. Fix: extract a `createCliAgent` factory from `cli.ts` and use it in all tests. Then add feature-parity tests covering node filesystem, node script executor, and SQLite persistence — mirroring the pattern bodhi-pi uses for its own implementations.

---

## Part 1 — Extract `src/agent.ts`

**New file: `packages/bodhi-pi-cli/src/agent.ts`**

```typescript
export interface CliAgentOptions {
  cwd: string;
  dbPath: string;
  models: Model<Api>[];
  defaultModelId: string;
  getApiKey: (provider: string) => string | undefined;
  systemPrompt?: string;
}

export interface CliAgent {
  factory: (conn: AgentSideConnection) => Agent;
  sessionStore: SessionStore;
  filesystem: Filesystem;
  cwd: string;
  models: Model<Api>[];
}

export function createCliAgent(opts: CliAgentOptions): CliAgent
```

Body: verbatim extraction from `cli.ts` lines 13–25 — creates `createNodeFilesystem(opts.cwd)`, `createSqliteSessionStore(opts.dbPath)`, `createNodeScriptExecutor()`, calls `createBodhiPiAgent(...)`, returns all four handles.

**Modify `src/cli.ts`**: import `createCliAgent`, replace inline wiring with:
```typescript
const agent = createCliAgent({ cwd: process.cwd(), dbPath: cfg.dbPath, ... });
await runRepl({ factory: agent.factory, cwd: agent.cwd, sessionStore: agent.sessionStore, models: agent.models });
```

---

## Part 2 — Create `test/helpers/`

These mirror bodhi-pi's `test/helpers/` but live in the CLI package. Copy verbatim:

| File | Source |
|------|--------|
| `test/helpers/in-process-connection.ts` | bodhi-pi `test/helpers/in-process-connection.ts` |
| `test/helpers/acp-constants.ts` | bodhi-pi `test/helpers/acp-constants.ts` |
| `test/helpers/notifications.ts` | bodhi-pi `test/helpers/notifications.ts` |
| `test/helpers/tool-call-asserts.ts` | bodhi-pi `test/helpers/tool-call-asserts.ts` |
| `test/helpers/faux-script.ts` | bodhi-pi `test/helpers/faux-script.ts` |

**New: `test/helpers/cli-harness.ts`** — async factory wrapping `createCliAgent` with a real tmpdir + temp SQLite:

```typescript
export interface CliTestHarness {
  clientConn: ClientSideConnection;
  updates: SessionNotification[];
  tmpDir: string;   // real temp dir on disk
  dbPath: string;   // SQLite file path inside tmpDir
  cleanup: () => Promise<void>;
}

export interface CliTestHarnessOptions {
  model: Model<Api>;
  apiKey: string;
  provider?: string;   // default: model.provider
}

export async function createCliTestHarness(opts: CliTestHarnessOptions): Promise<CliTestHarness>
```

Implementation:
1. `tmpDir = await fs.mkdtemp(os.tmpdir() + "/bodhi-pi-cli-e2e-")`
2. `dbPath = path.join(tmpDir, "sessions.db")`
3. `createCliAgent({ cwd: tmpDir, dbPath, models: [opts.model], defaultModelId: opts.model.id, getApiKey })`
4. Wire `createInProcessAcpPair(agent.factory, () => ({ sessionUpdate: async p => updates.push(p), requestPermission: async () => ({ outcome: { outcome: "approved" } }) }))`
5. `cleanup`: `fs.rm(tmpDir, { recursive: true, force: true })`

---

## Part 3 — `test/agent.test.ts` (integration, faux providers)

Uses `registerFauxProvider` + `createCliAgent` + real tmpdir. Runs under `vitest.config.ts` (no network required).

**Setup:**
```typescript
let tmpDir: string;
let dbPath: string;
let providers: FauxProviderRegistration[];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(...);
  dbPath = path.join(tmpDir, "sessions.db");
  providers = [];
});
afterEach(async () => {
  for (const p of providers) p.unregister();
  await fs.rm(tmpDir, { recursive: true, force: true });
});
```

Helper:
```typescript
function wireHarness(model: Model<Api>) {
  const agent = createCliAgent({ cwd: tmpDir, dbPath, models: [model], defaultModelId: model.id, getApiKey: () => "test-key" });
  const updates: SessionNotification[] = [];
  const { clientConn } = createInProcessAcpPair(agent.factory, () => ({
    sessionUpdate: async p => updates.push(p),
    requestPermission: async () => ({ outcome: { outcome: "approved" } }),
  }));
  return { clientConn, updates, agent };
}
```

**Tests:**

1. **`write tool creates a real file on disk`**
   - Faux scripts `write({ path: path.join(tmpDir, "out.txt"), content: "hello node" })` then `"done"`
   - Assert: `await fsNode.readFile(path.join(tmpDir, "out.txt"), "utf-8")` equals `"hello node"`

2. **`read tool reads a real file from disk`**
   - Seed `path.join(tmpDir, "seed.txt")` with `"disk content"` via `fsNode.writeFile` before test
   - Faux scripts `read({ path: path.join(tmpDir, "seed.txt") })` then `"done"`
   - Assert: `toolCallUpdates(updates)[0].status === "completed"` and result contains `"disk content"`

3. **`run_script spawns a real Node process`**
   - Seed `greet.js` with `console.log("spawned: " + args[0]);` to tmpDir
   - Faux scripts `run_script({ path: scriptPath, args: ["world"] })` then `"done"`
   - Assert: tool result contains `"spawned: world"` and `exitCode: 0`

4. **`node filesystem jail blocks writes outside cwd`**
   - Faux scripts `write({ path: "/etc/hacked.txt", content: "oops" })`
   - Assert: `toolCallUpdates(updates)[0].status === "failed"`

5. **`SQLite db file is created on first session`**
   - Faux scripts `"acknowledged"`
   - Assert: `await fsNode.access(dbPath)` resolves (file exists on disk)

6. **`session history survives across two agent instances sharing the same dbPath`**
   - Agent 1 faux: `"noted"`. Create session, send prompt. Assert `chunkedAgentText` contains `"noted"`.
   - Agent 2: fresh `createCliAgent({ cwd: tmpDir, dbPath, ... })` with new faux model. Call `clientConn.loadSession({ sessionId, cwd: tmpDir })`.
   - Assert: `chunkedAgentText(updates2)` contains `"noted"` (history replayed via user/agent chunk notifications)

---

## Part 4 — Rewrite `e2e/repl.e2e.ts`

Remove all in-memory wiring. Replace with:

```typescript
import { getModel } from "@mariozechner/pi-ai";
import { createCliTestHarness } from "../test/helpers/cli-harness.js";
import { stdInitParams } from "../test/helpers/acp-constants.js";
import { chunkedAgentText } from "../test/helpers/notifications.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;
let harness: CliTestHarness;

beforeEach(async () => {
  harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
});
afterEach(async () => { await harness.cleanup(); });

test("CLI agent returns end_turn and streams chunks", async () => {
  await harness.clientConn.initialize(stdInitParams);
  const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });
  const result = await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "Reply with exactly one word: hello" }] });
  expect(result.stopReason).toBe("end_turn");
  expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("hello");
});
```

Key diff from current: model `gpt-4o-mini` (was `gpt-5-mini`), uses real `createCliAgent`, `harness.tmpDir` as `cwd`.

---

## Part 5 — `e2e/fs.e2e.ts` (new)

Uses `createCliTestHarness` + `gpt-4o-mini`. Tests real disk I/O:

1. **`write tool creates a real file in tmpDir`** — prompt LLM to write `"disk-written"` to `target`; assert via `fsNode.readFile(target)`
2. **`read tool reads a pre-seeded file`** — seed `seed.txt` with `"real disk content"`; prompt LLM to read it; assert `chunkedAgentText` contains `"real disk content"`
3. **`ls tool lists real tmpDir entries`** — create `alpha.txt`, `beta.txt`; prompt LLM to ls; assert both names in response

---

## Part 6 — `e2e/scripts.e2e.ts` (new)

Uses `createCliTestHarness` + `gpt-4o-mini`. Tests real Node process spawning:

1. **`run_script executes a real Node process`** — seed `greet.js` with `console.log("greetings from " + args[0])`; prompt LLM to run with `args=["node-process"]`; assert `chunkedAgentText` contains `"greetings from node-process"`
2. **`run_script captures non-zero exit code`** — seed `fail.js` with `process.exit(42)`; prompt LLM to run and report exit code; assert response contains `"42"`

---

## Part 7 — `e2e/sessions.e2e.ts` (new)

Uses `createCliTestHarness` + `gpt-4o-mini`. Tests SQLite persistence:

1. **`session history survives CLI restart`**
   - Harness 1: create session, prompt `"My secret number is 77. Acknowledge with: stored"`; assert `"stored"` in response
   - Harness 2: `createCliAgent({ cwd: h1.tmpDir, dbPath: h1.dbPath, ... })`; call `loadSession({ sessionId, cwd: h1.tmpDir })`; history replays; then prompt `"What was my secret number?"`; assert response contains `"77"`

---

## Verification

```bash
# Unit/integration (no network)
cd packages/bodhi-pi-cli
npm test

# E2E (requires OPENAI_API_KEY in .env)
npm run test:e2e
```

All 6 integration tests in `test/agent.test.ts` must pass without network. All 6+ e2e tests must pass against real `gpt-4o-mini`.

---

## Critical Files

| Action | Path |
|--------|------|
| **New** | `packages/bodhi-pi-cli/src/agent.ts` |
| **Modify** | `packages/bodhi-pi-cli/src/cli.ts` |
| **New** | `packages/bodhi-pi-cli/test/helpers/in-process-connection.ts` |
| **New** | `packages/bodhi-pi-cli/test/helpers/acp-constants.ts` |
| **New** | `packages/bodhi-pi-cli/test/helpers/notifications.ts` |
| **New** | `packages/bodhi-pi-cli/test/helpers/tool-call-asserts.ts` |
| **New** | `packages/bodhi-pi-cli/test/helpers/faux-script.ts` |
| **New** | `packages/bodhi-pi-cli/test/helpers/cli-harness.ts` |
| **New** | `packages/bodhi-pi-cli/test/agent.test.ts` |
| **Rewrite** | `packages/bodhi-pi-cli/e2e/repl.e2e.ts` |
| **New** | `packages/bodhi-pi-cli/e2e/fs.e2e.ts` |
| **New** | `packages/bodhi-pi-cli/e2e/scripts.e2e.ts` |
| **New** | `packages/bodhi-pi-cli/e2e/sessions.e2e.ts` |

Reference: `packages/bodhi-pi/test/helpers/` (verbatim copy sources for in-process-connection, acp-constants, notifications, tool-call-asserts, faux-script)
