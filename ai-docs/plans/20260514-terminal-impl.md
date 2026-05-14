# Terminal/Bash integration for bodhi-pi agent

Date: 2026-05-14 · Branch: main · Status: planning

## Context

The bodhi-pi agent inverts ACP: the agent owns filesystem and tools, not the client. Today it exposes `read`/`write`/`edit`/`ls`/`find`/`grep`/`run_script` (the last conditionally registered when a `ScriptExecutor` is injected). We want to add a `bash` tool the same way — define a `Terminal` capability in `bodhi-pi` core, inject a concrete implementation per test-app, conditionally register the tool.

Three reference shells, one interface:

- **`test-app-cli`** → real `bash` via `child_process.spawn('bash', ['-c', …])`. Trusted local dev.
- **`test-app-http`** (covers http + ws e2e projects) → `just-bash` (node entrypoint). Sandboxed JS shell.
- **`test-app-browser`** (covers browser + chrome-ext) → `just-bash/browser`. Browser-safe subset.

Per user direction, **adapter implementations live in the test apps only** — `bodhi-pi-node` and `bodhi-pi-browser` ship no terminal adapters. The publishable packages export the interface; production users bring their own `Terminal`.

Prior art: `BodhiSearch/pi-mono/packages/web-acp-agent/src/agent/tools/bash-tool.ts` (256 KiB per-stream cap, AbortController chain, TypeBox schema with stdin/cwd/timeout_ms, JSON result for LLM + structured details). Cross-framework survey: `ai-docs/plans/next-we-want-to-rustling-nova-agent-a7fd6368b357ff4ab.md` (Mastra, opencode, Claude Code, OpenAI Codex, ACP). Convergent v1 shape confirmed: single `command: string`, `cwd`, `timeoutMs` in ms, separated stdout/stderr/exitCode, AbortSignal, byte-cap truncation; stdin commonly redirected to /dev/null but cheap to support where the runtime allows.

Outcome: every existing runtime keeps working unchanged; e2e projects that wire a `Terminal` get a `bash` tool the LLM can call; shared e2e specs validate the contract across all three reference shells.

---

## Design — follows the post-reorg `src/` convention

The recent reorg established a clear domain-folder convention (per the user's `bodhi_pi_src_layout` memory and the latest exploration):

- Flat files inside a domain folder; **no `index.ts` barrel**, imports are explicit `./terminal.js`.
- Naming: `<domain>.ts` for the interface, `in-memory-<domain>.ts` for the testing impl, `<domain>-service.ts` **only when the domain exposes ACP extension methods** (kv, settings, sessions). Pure capability interfaces consumed only by tools follow the `script-executor/` template — interface file only.
- Tests are co-located (`*.test.ts` next to the source).
- Constants live in `wire/constants.ts`, not in domain folders.

Terminal is **purely capability**, consumed by the `bash` tool — no ACP method surface. So we mirror `src/script-executor/` exactly: one interface file, plus an in-memory impl for tests. No `terminal-service.ts`.

### 1. `Terminal` interface — `packages/bodhi-pi/src/terminal/`

```
src/terminal/
├── terminal.ts                  # interface + types
├── in-memory-terminal.ts        # testing impl (configurable canned responses)
└── in-memory-terminal.test.ts   # co-located
```

`src/terminal/terminal.ts`:

```ts
export interface Terminal {
  readonly capabilities: TerminalCapabilities;
  exec(input: TerminalExecInput): Promise<TerminalExecResult>;
}

export interface TerminalCapabilities {
  cwd: boolean;               // honours input.cwd
  env: boolean;               // honours input.env
  stdin: boolean;             // honours input.stdin
  timeout: boolean;           // enforces input.timeoutMs
  cancel: boolean;            // observes input.signal
  separateStreams: boolean;   // false => stderr is empty; stdout has merged output
}

export interface TerminalExecInput {
  command: string;                       // single shell line; pipes & redirects ok
  cwd?: string;                          // absolute; falls back to runtime default
  env?: Record<string, string>;          // merged onto inherited env
  stdin?: string;                        // absent => stdin is /dev/null
  timeoutMs?: number;                    // hard kill after N ms; undefined => no timeout
  signal?: AbortSignal;                  // cooperative cancellation
  outputByteLimit?: number;              // per-stream byte cap; default 262_144
}

export interface TerminalExecResult {
  stdout: string;
  stderr: string;                        // empty if capabilities.separateStreams === false
  exitCode: number | null;               // null when terminated by signal
  signal: string | null;                 // e.g. 'SIGTERM'
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;                    // true if either stream hit outputByteLimit
}
```

Rationale (mirrors the cross-framework convergent shape and the user's "rich with degraded support" answer):

- **Single `command: string`** (not `args[]`) — matches opencode (`command`), Claude Code, Mastra, web-acp-agent; LLM ergonomics favour shell lines with pipes. Only codex uses `command[]`.
- **`capabilities` object** — adapters declare what they honour; lets the tool layer pass fields through and lets the adapter ignore what it can't enforce. Matches the user's "we can have degraded support" answer. Surfaced at session start so the system prompt can describe the actual shell.
- **No `spawn`/background, no streaming callbacks in v1** — none of the three target shells need them. Non-breaking to add later.
- **`outputByteLimit` default 256 KiB** — web-acp-agent's choice, aligns with Claude (50 KB) and OpenAI's `max_output_length`.
- **`exitCode: number | null` + `signal: string | null`** — exactly ACP's `TerminalExitStatus`, matches Node's child_process semantics.

`src/terminal/in-memory-terminal.ts` mirrors `src/filesystem/in-memory-filesystem.ts` and `src/kv/in-memory-kv-store.ts`: `createInMemoryTerminal(opts)` returns a `Terminal` whose `exec` consults a configurable handler map or default canned responses. Used by core unit tests and as a fallback in `test/helpers/harness.ts`.

### 2. `bash` tool — `packages/bodhi-pi/src/tools/`

Two new files alongside the existing tool files, matching the convention there:

- `src/tools/bash.ts`
- `src/tools/bash.test.ts`

Mirrors `src/tools/run-script.ts` (template):

```ts
const bashSchema = Type.Object({
  command: Type.String({ description: 'Bash command to execute. Supports pipes and redirections.' }),
  description: Type.Optional(Type.String({ description: '5-10 word summary, used by UI/permissions.' })),
  cwd: Type.Optional(Type.String({ description: 'Absolute working directory. Defaults to session cwd.' })),
  timeout_ms: Type.Optional(Type.Number({ description: 'Hard timeout in milliseconds. Default 120000.', minimum: 1 })),
  stdin: Type.Optional(Type.String({ description: 'Standard input piped into the command.' })),
});

// execute(toolCallId, input):
// 1. Resolve cwd against deps.cwd if relative.
// 2. Compose AbortSignal from external (turn cancel) + AbortSignal.timeout(timeout_ms ?? 120_000)
//    when capabilities.timeout || capabilities.cancel.
// 3. Call deps.terminal.exec({ command, cwd, stdin, timeoutMs, signal, outputByteLimit: 262_144 }).
// 4. Build result as { content: [{ type:'text', text: JSON.stringify(details) }], details },
//    where details = { stdout, stderr, exitCode, signal, durationMs, timedOut, truncated }.
//    Non-zero exit codes are NOT thrown; the model gets the data and decides.
// 5. Errors thrown by the adapter (genuine crashes, not exit codes) surface as standard tool errors.
```

The `description` field comes through from the schema and is forwarded into the ACP tool-call update (per opencode/Claude Code precedent — used by UI/permissions, optional for the model).

### 3. `src/tools/index.ts` changes

Two minimal edits to the existing factory (~lines 13-47):

```ts
export interface ToolDeps {
  filesystem: Filesystem;
  cwd: string;
  scriptExecutor?: ScriptExecutor;
  terminal?: Terminal;                      // NEW
}

export function createBuiltinTools(deps: ToolDeps): AgentTool[] {
  const tools: AgentTool[] = [
    createReadTool(deps),
    createWriteTool(deps),
    createEditTool(deps),
    createLsTool(deps),
    createFindTool(deps),
    createGrepTool(deps),
  ];
  if (deps.scriptExecutor) tools.push(createRunScriptTool(deps));
  if (deps.terminal) tools.push(createBashTool(deps));   // NEW
  return tools;
}

export const BUILTIN_TOOL_SNIPPETS: Record<string, string> = {
  // ...existing rows...
  bash: "Execute a bash command; returns stdout, stderr, exit code, and a truncated flag",  // NEW
};
```

### 4. `BodhiPiConfig` change — `packages/bodhi-pi/src/acp/agent.ts` lines 63-100

Add one optional field next to `scriptExecutor`:

```ts
export interface BodhiPiConfig {
  // ...existing fields unchanged...
  scriptExecutor?: ScriptExecutor;
  terminal?: Terminal;                                   // NEW — host injection
  // ...rest unchanged...
}
```

No new service registration needed (Terminal exposes no ACP extension methods).

### 5. Session bootstrap plumbing — `packages/bodhi-pi/src/acp/session-bootstrap.ts`

Thread `terminal` through to `ToolDeps` wherever `createBuiltinTools` is called today. The exact call site (likely in `buildSessionState`, which composes the per-session `ToolDeps` from `config` + `cwd` + `scriptExecutor`) gets one added field:

```ts
const builtinTools = createBuiltinTools({
  filesystem: config.filesystem,
  cwd,
  ...pickDefined({ scriptExecutor: config.scriptExecutor }),
  ...pickDefined({ terminal: config.terminal }),     // NEW
});
```

`pickDefined` is the existing helper for optional injections (used at `src/acp/agent.ts:185-188` for `kvStore`).

### 6. Filesystem extension (only as much as just-bash actually needs)

Audit `just-bash`'s `IFileSystem` calls against our golden-path bash specs and add the minimum needed to `src/filesystem/filesystem.ts`. Expected additions (confirm during impl):

- `appendTextFile(absolutePath: string, content: string): Promise<void>` — needed by `>>` redirection.
- `rename(src: string, dst: string): Promise<void>` — needed by `mv`.
- `copy(src: string, dst: string, opts?: { recursive?: boolean }): Promise<void>` — needed by `cp`.

We do **not** add: `chmod`, `symlink`, `link`, `readlink`, `utimes`, `realpath`, `lstat`, `getAllPaths`, `readFileBuffer`. The `app-utils/just-bash-fs-adapter.ts` (see §7d) provides these as no-ops / swallow `ENOSYS` (the web-acp-agent pattern at `volume-filesystem.ts:144`).

Update implementations in lockstep (one commit, per the phasing rule that each runtime piece lands together):

- `packages/bodhi-pi/src/filesystem/in-memory-filesystem.ts` (+ co-located test)
- `packages/bodhi-pi-node/src/filesystem/node-filesystem.ts`
- `packages/bodhi-pi-browser/src/filesystem/<zenfs-impl>.ts` (find exact filename during impl)

### 7. Per-runtime adapter strategy (test-apps own these)

Each test app owns its terminal adapter and wires it into the `createBodhiPiAgent` config it builds. No code in `bodhi-pi-node` / `bodhi-pi-browser` for terminals.

#### 7a. `test-app-cli` — real bash via child_process

Location: `packages/bodhi-pi/e2e/test-app-cli/src/terminal/exec-bash-terminal.ts`

```ts
export function createExecBashTerminal(): Terminal {
  return {
    capabilities: { cwd: true, env: true, stdin: true, timeout: true, cancel: true, separateStreams: true },
    async exec({ command, cwd, env, stdin, timeoutMs, signal, outputByteLimit = 262_144 }) {
      // spawn('bash', ['-c', command], { cwd, env: {...process.env, ...env}, stdio: ['pipe','pipe','pipe'] })
      // - feed stdin if provided then end()
      // - capture stdout/stderr; stop appending past outputByteLimit per stream; set truncated=true
      // - composed AbortController = external signal + AbortSignal.timeout(timeoutMs)
      // - on abort: SIGTERM, then SIGKILL after 1s grace
      // - resolve with { stdout, stderr, exitCode, signal, durationMs, timedOut, truncated }
    },
  };
}
```

Wire into the test-app-cli agent factory next to `createNodeFilesystem`/`createNodeScriptExecutor`.

#### 7b. `test-app-http` — `just-bash` (node)

Location: `packages/bodhi-pi/e2e/test-app-http/src/terminal/just-bash-terminal.ts`

```ts
import { Bash } from 'just-bash';
import type { Filesystem } from '@bodhi/bodhi-pi';
import { createJustBashFsAdapter } from '../../../app-utils/just-bash-fs-adapter.js';

export function createJustBashTerminal(opts: { filesystem: Filesystem }): Terminal {
  return {
    capabilities: { cwd: true, env: true, stdin: true, timeout: true, cancel: true, separateStreams: true },
    async exec(input) {
      const fs = createJustBashFsAdapter(opts.filesystem);
      const bash = new Bash({ fs, cwd: input.cwd ?? '/' });   // fresh per call — no shell state across turns
      // translate input → bash.exec(command, { cwd, env, stdin, signal })
      // wrap with our own timeout AbortController composing input.signal + AbortSignal.timeout
      // apply outputByteLimit truncation post-hoc
      // return { stdout, stderr, exitCode, signal, durationMs, timedOut, truncated }
    },
  };
}
```

Wire in the test-app-http server bootstrap. `bodhi-pi-http` rebuilds the agent per request, so a fresh Terminal instance per request falls out naturally. Add `just-bash` to `test-app-http/package.json` devDependencies (pin to web-acp-agent's `2.14.2`).

#### 7c. `test-app-browser` — `just-bash/browser`

Location: `packages/bodhi-pi/e2e/test-app-browser/src/terminal/just-bash-browser-terminal.ts`

Identical to 7b except `import { Bash } from 'just-bash/browser'`. Same capabilities object. Vite config must allow the subpath import; confirm no node externals leak (`child_process`, `node:zlib`). Both `browser` and `chrome-ext` projects share this host, so one wiring covers both.

#### 7d. Shared `IFileSystem`-over-`Filesystem` adapter

Location: `packages/bodhi-pi/e2e/app-utils/just-bash-fs-adapter.ts` (per the user's `bodhi_pi_e2e_layout` memory — `app-utils/` is the right home for cross-test-app helpers).

Shape:

```ts
import type { Filesystem } from '@bodhi/bodhi-pi';

export function createJustBashFsAdapter(filesystem: Filesystem): IFileSystem {
  return {
    // Direct delegates onto Filesystem:
    readFile: (p) => filesystem.readTextFile(p),
    writeFile: (p, c) => filesystem.writeTextFile(p, typeof c === 'string' ? c : new TextDecoder().decode(c)),
    appendFile: (p, c) => filesystem.appendTextFile(p, /* ... */),
    exists: (p) => filesystem.exists(p),
    stat: (p) => filesystem.stat(p).then(adaptStat),
    mkdir: (p, o) => filesystem.mkdir(p, o),
    readdir: (p) => filesystem.list(p).then((e) => e.map((x) => x.name)),
    readdirWithFileTypes: (p) => filesystem.list(p).then((e) => e.map(adaptDirent)),
    rm: (p, o) => filesystem.remove(p, o),
    cp: (s, d, o) => filesystem.copy(s, d, o),
    mv: (s, d) => filesystem.rename(s, d),

    // Path utilities (pure):
    resolvePath: (base, p) => posix.resolve(base, p),

    // No-op / swallow ENOSYS:
    chmod: async () => {},
    symlink: async () => { throw enosys('symlink'); },
    link: async () => { throw enosys('link'); },
    readlink: async () => { throw enosys('readlink'); },
    utimes: async () => {},
    realpath: async (p) => p,
    lstat: (p) => filesystem.stat(p).then(adaptStat),
    getAllPaths: () => [],

    // Buffer variant — encode the text:
    readFileBuffer: (p) => filesystem.readTextFile(p).then((s) => new TextEncoder().encode(s)),
  };
}
```

---

## Phasing (depth-first per runtime, per user direction & `phasing_depth_first` memory)

One commit per runtime, end-to-end. Each commit lands the contract pieces it needs, its adapter, host wiring, and that runtime's e2e coverage.

### Commit 1 — `Terminal` interface + `bash` tool + cli runtime

Core (`packages/bodhi-pi/`):

- `src/terminal/terminal.ts` — interface + types (no barrel).
- `src/terminal/in-memory-terminal.ts` — testing impl.
- `src/terminal/in-memory-terminal.test.ts` — co-located.
- `src/tools/bash.ts` — TypeBox schema + `execute()`.
- `src/tools/bash.test.ts` — uses `createInMemoryTerminal` to drive deterministic outputs.
- `src/tools/index.ts` — extend `ToolDeps`; conditional registration; add `bash` row to `BUILTIN_TOOL_SNIPPETS`.
- `src/acp/agent.ts` — add `terminal?: Terminal` to `BodhiPiConfig` (~line 92 area, next to `scriptExecutor`).
- `src/acp/session-bootstrap.ts` — thread `config.terminal` into the `createBuiltinTools` call via `pickDefined`.
- `src/index.ts` — re-export `Terminal`, `TerminalExecInput`, `TerminalExecResult`, `TerminalCapabilities`.
- `test/helpers/harness.ts` — add optional `terminal?: Terminal` (default: undefined, no `bash` tool).

Test app (cli):

- `e2e/test-app-cli/src/terminal/exec-bash-terminal.ts`.
- `e2e/test-app-cli/src/agent.ts` (or current entrypoint) — inject `terminal: createExecBashTerminal()`.
- `e2e/shared/terminal-bash.e2e.ts` — golden-path specs, gated to `in-memory` + `cli` projects at this phase.

Verification:

```bash
npm --workspace packages/bodhi-pi test
npm --workspace packages/bodhi-pi run test:e2e -- --project=in-memory --project=cli
```

Plus one model-roundtrip: ask the agent to `echo hello && pwd` via test-app-cli and assert the LLM response includes both.

### Commit 2 — `just-bash` (node) for http + ws

Core:

- Extend `src/filesystem/filesystem.ts` with `appendTextFile`, `rename`, `copy`.
- Update `src/filesystem/in-memory-filesystem.ts` + co-located test.
- Update `packages/bodhi-pi-node/src/filesystem/node-filesystem.ts` (and its test).

App-utils:

- `e2e/app-utils/just-bash-fs-adapter.ts` — the shared IFileSystem adapter.
- `e2e/app-utils/just-bash-fs-adapter.test.ts` (optional, but cheap — verifies the adapter against `createInMemoryFilesystem`).

Test app (http):

- `e2e/test-app-http/src/terminal/just-bash-terminal.ts`.
- `e2e/test-app-http/src/server.ts` (or per-request agent builder) — inject `terminal: createJustBashTerminal({ filesystem })`.
- `e2e/test-app-http/package.json` — add `just-bash` to devDependencies.
- `e2e/shared/terminal-bash.e2e.ts` — extend matrix to `http` + `ws`.

Verification:

```bash
npm --workspace packages/bodhi-pi run test:e2e -- --project=http --project=ws
```

Plus one curl: hit the test-app-http endpoint with a prompt that triggers `bash`; confirm round-trip output.

### Commit 3 — `just-bash/browser` for browser + chrome-ext

Core:

- Update `packages/bodhi-pi-browser/src/filesystem/<zenfs-impl>.ts` to satisfy the extended `Filesystem` (`appendTextFile`/`rename`/`copy`). ZenFS exposes these natively.

Test app (browser):

- `e2e/test-app-browser/src/terminal/just-bash-browser-terminal.ts`.
- `e2e/test-app-browser/src/host.ts` (or current entrypoint) — inject `createJustBashBrowserTerminal({ filesystem })`. Same wiring covers `browser` + `chrome-ext` projects.
- `e2e/test-app-browser/package.json` — add `just-bash` (browser subpath import).
- Vite config — verify no node externals; `just-bash/browser` resolves cleanly.
- `e2e/shared/terminal-bash.e2e.ts` — extend matrix to `browser` + `chrome-ext`.

Verification:

```bash
npm --workspace packages/bodhi-pi run test:e2e -- --project=browser --project=chrome-ext
```

Plus a Playwright trace showing the `bash` tool fires in-browser and the result flows back through the ACP wire.

---

## Critical files (read before starting)

- `packages/bodhi-pi/src/acp/agent.ts:63-100` — current `BodhiPiConfig`.
- `packages/bodhi-pi/src/acp/agent.ts:185-188` — example of `pickDefined({ kvStore: config.kvStore })` (the pattern to copy for `terminal`).
- `packages/bodhi-pi/src/acp/session-bootstrap.ts` — where the per-session `ToolDeps` is built.
- `packages/bodhi-pi/src/tools/index.ts:13-47` — `ToolDeps`, `createBuiltinTools`, `BUILTIN_TOOL_SNIPPETS`.
- `packages/bodhi-pi/src/tools/run-script.ts` — exact template for `bash.ts`.
- `packages/bodhi-pi/src/script-executor/script-executor.ts` — exact template for `terminal/terminal.ts` (interface-only domain folder; no service).
- `packages/bodhi-pi/src/filesystem/filesystem.ts:9-43` — interface to extend.
- `packages/bodhi-pi/src/filesystem/in-memory-filesystem.ts` — pattern for `in-memory-terminal.ts`.
- `packages/bodhi-pi/src/kv/in-memory-kv-store.ts` — alt pattern for `createInMemoryX` factory.
- `packages/bodhi-pi/test/helpers/harness.ts` — where to add the optional `terminal` arg.
- `packages/bodhi-pi/e2e/helpers/harness.ts` — runtime-dispatching e2e harness.
- `packages/bodhi-pi/e2e/CLAUDE.md` — e2e conventions.

Prior art to consult (do not copy):

- `BodhiSearch/pi-mono/packages/web-acp-agent/src/agent/tools/bash-tool.ts` — closest existing integration.
- `BodhiSearch/pi-mono/packages/web-acp-agent/src/agent/tools/volume-filesystem.ts` — IFileSystem-over-something pattern (informs `just-bash-fs-adapter.ts`).
- `ai-docs/plans/next-we-want-to-rustling-nova-agent-a7fd6368b357ff4ab.md` — cross-framework research.

---

## Verification (end-to-end, once all three commits land)

```bash
npm --workspace packages/bodhi-pi test
npm --workspace packages/bodhi-pi run test:e2e
```

Golden-path specs in `e2e/shared/terminal-bash.e2e.ts` (each gated by adapter capabilities to keep `skip_blocked_features` policy):

1. `echo hello` → `stdout="hello\n"`, `exitCode=0`.
2. `cat /nope 2>&1; exit 2` → `exitCode=2`; on `capabilities.separateStreams` adapters, verify stdout vs stderr split; otherwise verify the merged output stream.
3. Multi-line pipeline: `printf 'a\nb\nc\n' | wc -l` → `stdout` contains `3`.
4. **Shared filesystem invariant**: agent uses `write` tool to create a file at `cwd/foo.txt`, then `bash` `ls cwd/foo.txt` returns it. Proves the IFileSystem adapter is observing the same Filesystem.
5. Timeout (`capabilities.timeout`): `sleep 5` with `timeout_ms=200` → `timedOut=true`, `signal="SIGTERM"`, `exitCode=null`.
6. External cancel (`capabilities.cancel`): `session/cancel` mid-`sleep` → `signal="SIGTERM"`, `timedOut=false`.
7. Truncation: print 1 MB stdout with `outputByteLimit=65536` → `truncated=true`, `stdout.length <= 65536`.
8. stdin (`capabilities.stdin`): `cat` with `stdin="hello"` → `stdout="hello"`.

Manual sanity per host:

- cli: launch test-app-cli, ask "list markdown files in cwd using bash"; observe `bash` tool call and sensible answer.
- http: same prompt via test-app-http's ACP wire.
- browser: same prompt in test-app-browser (Playwright capture).

Memory hygiene this plan satisfies:

- `bodhi_pi_src_layout` — flat domain folder, no `index.ts`, interface-only (no service), co-located tests.
- `bodhi_pi_e2e_layout` — shared adapter helper in `app-utils/`; per-runtime adapters in their test app under `src/terminal/`.
- `bodhi_pi_node_not_bun` — all commands `npm`/`node`.
- `bodhi_pi_e2e_strategy` — gpt-4o-mini for any LLM-in-the-loop spec.
- `phasing_depth_first` — three commits, one per runtime end-to-end.
- `skip_blocked_features` — capability-gated specs (e.g. `stdin`, `separateStreams`) skip on adapters that don't honour the field, rather than blocking the commit.
