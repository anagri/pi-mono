# Unblock the 12 skipped e2e-ui specs

## Context

Commit `5cacab30` landed the `packages/bodhi-pi/e2e-ui/` Playwright suite as
the matrix-wide UI test tier (one set of specs × four projects: `http`, `ws`,
`browser`, `chrome-ext`). It went green for the four straightforward feature
specs (`simple-chat`, `tool-call`, `workspace-fs`, `terminal`) = 16/28 passing.

The remaining three specs are present only as `test.skip(...)` stubs:

- `shared/model-switch.spec.ts`
- `shared/commands-extensions-skills.spec.ts`
- `shared/session-tree.spec.ts`

All three are blocked on two missing capabilities in the shared
`e2e/app-utils/browser/ui/AppShell.tsx`:

1. **Composer slash dispatch.** Today `AppShell.onComposerSend` forwards every
   input to `session/prompt`. Slash commands that should run client-side
   (`/model`, `/fork`, `/clone`, `/sessions`, `/new`, `/resume`, `/close`) have
   nowhere to land — they reach the agent as a literal prompt and the spec
   contracts fail. Reference implementation lives in
   `packages/bodhi-pi-browser/src/ui/commands.ts`
   (`handleCommand(line, ctx)`) but is `BodhiPiClient`-shaped, not raw
   `ClientSideConnection`-shaped, so it can't be imported as-is.
2. **`currentModel` tracking.** `AppShell.tsx:32` declares
   `const [currentModel] = useState<string>("")` — never updated. The
   `data-current-model` attribute on `chat-panel` therefore stays empty, so
   `model-switch` can never observe a flip.

Plus three small ancillary gaps: the spec stubs are empty, the
`commands-extensions-skills` scenarios don't yet exist under
`packages/bodhi-pi/e2e-ui/data/`, and `ChatPanelPage.currentModel/sessionId`
return the root locator instead of attribute values.

**Outcome:** all four projects run the same 7-spec set →
`28/28` passing (was `16 pass + 12 skip`). `e2e/shared` stays green
across the matrix.

## Slash command architecture (decided up-front)

A slash command in bodhi-pi falls into exactly one of three buckets. Where
it's handled is determined by which bucket it's in — there is no
configuration knob, no `AgentConfig.advertiseCommands`, and no possibility
of moving (1) into the agent.

| Bucket | Examples | Handled where | Why |
|---|---|---|---|
| (1) **RPC-mapped client commands** | `/model`, `/sessions`, `/new`, `/resume`, `/close`, `/fork`, `/clone`, `/compact`, `/entries`, `/tree`, `/goto`, `/help`, `/settings`, `/login`, `/logout`, `/logins`, `/clear`, `/export`, `/name`, `/session`, `/config`, `/delete` | **Client (host)** | Each maps 1:1 to an ACP RPC method with a defined return shape. The host renders the result however fits its UI (chat bubble, side panel, stdout, quick-pick). ACP's `available_commands_update` channel is not designed for these — it's for prompt-shaped commands. |
| (2) **Prompt-expansion commands** | `.bodhi-pi/commands/<name>.md` (template), `skill:<name>`, extension `registerCommand` names | **Agent** | The agent discovers them during `session/new`/`session/load`, advertises them via `available_commands_update`, and expands the template/skill body before the LLM sees the prompt. Client forwards verbatim. |
| (3) **Pure client UI commands** | (currently empty for bodhi-pi) | **Client** | No agent interaction at all. |

**Precedence rule** (agent-advertised wins over local — same as
`bodhi-pi-browser/src/ui/RuntimeProvider.tsx:201`):

1. Input doesn't start with `/` → forward to `session/prompt`.
2. Starts with `/` and the name appears in `availableCommands` → forward
   to `session/prompt`. Agent expands the template/skill/extension command
   before the LLM round-trips. (A project-installed `/model` shadows the
   host's built-in by design — the project author opted in.)
3. Starts with `/` and the name is in the host's local registry → dispatch
   locally; never reaches the agent.
4. Otherwise → forward verbatim. Agent treats it as literal text. This is
   the "unknown slash falls through" path that the existing
   `bodhi-pi-web/e2e/commands.spec.ts:46-55` test pins down.

**Why not move (1) to the agent?**
- ACP already exposes every action via an RPC method; the slash is UX
  sugar over that RPC. Two registries (RPC + slash advertise) solve the
  same problem twice on the wrong side of the wire.
- Render style would lock to whatever the agent prints. Different hosts
  (CLI / browser / VSCode quick-pick) need different formats.
- Survey of other agent stacks (Claude Code, Aider, continue.dev, Cursor,
  the in-repo coding-agent this is modeled on) all keep (1) client-side.

**Why not put (2) on the client?**
- Project commands and skills live on disk in the user's project tree.
  The agent already has filesystem access for discovery; the host doesn't
  necessarily. Forcing every host to re-implement discovery would
  duplicate the walk in `src/commands/` and `src/skills/`.
- Extension `registerCommand` runs inside the agent runtime — extensions
  can't reach across the ACP wire to register on the client.

This commit does not change any of the above — it just makes the shared
`e2e/app-utils/browser/ui/AppShell` honor the rule, so all four
reference UIs and their Playwright specs agree.

## Approach

Land everything as one commit on `main` — it's a single coherent unlock and
the existing 16-spec baseline gates the whole thing.

### 1. New file — local slash dispatcher

`packages/bodhi-pi/e2e/app-utils/browser/ui/commands.ts`

Ported from `bodhi-pi-browser/src/ui/commands.ts` but operates on raw
`ClientSideConnection` (not the publishable `BodhiPiClient` wrapper, which
isn't reachable from the `e2e/` tree per the
`bodhi-pi/e2e/CLAUDE.md` "Don't depend on bodhi-pi-* packages" rule).

```ts
import type { AvailableCommand, ClientSideConnection } from "@agentclientprotocol/sdk";

export interface SlashState {
  sessionId: string;
  availableCommands: AvailableCommand[];
}

export interface SlashContext {
  conn: ClientSideConnection;
  cwd: string;
  state: SlashState;
  pushSystemMessage(text: string): void;
  setSessionId(id: string): void;
  setCurrentModel(id: string): void;
}

export type SlashOutcome =
  | { handled: true }                  // local — caller should NOT forward to session/prompt
  | { handled: false };                // unknown or shadowed by availableCommands — caller forwards

export function isSlash(line: string): boolean { return line.trim().startsWith("/"); }

export async function tryHandleSlash(line: string, ctx: SlashContext): Promise<SlashOutcome>;
```

Dispatch policy (implements the four-rule precedence from "Slash command
architecture" above — agent-advertised wins):

- If `line` starts with `/` and the command **name** appears in
  `ctx.state.availableCommands`, return `{ handled: false }` so the caller
  forwards to `session/prompt`. The agent's prompt-loop expands the
  template/skill/extension command before the LLM sees it.
- Otherwise switch on the name. Supported in this commit:
  `/model`, `/sessions`, `/new`, `/resume`, `/close`, `/fork`, `/clone`.
  Any other unknown slash → `{ handled: false }` (agent receives it verbatim
  and the agent's own command/skill expansion runs).

Each local case calls the matching `conn.*` method (raw ACP shape, no
client wrapper), pushes a one-line system message into chat history, and
updates the relevant state (sessionId / currentModel) so the data
attributes flip. `/model <id>` calls
`conn.setSessionConfigOption({ sessionId, configOptionId: "model", value: id })`
and reads `result.configOptions` to pull the new `currentValue` for the
`model` entry.

This file is **not** a re-export of `bodhi-pi-browser/src/ui/commands.ts`
(blocked by the no-import-sibling-package rule); it's a fresh, narrower
implementation. Cross-runtime parity with `bodhi-pi-browser` is enforced by
the same e2e specs running through both surfaces.

### 2. Modify `AppShell.tsx`

`packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx`

- Convert `currentModel` from `const [...] = useState("")` to a mutable
  state pair `[currentModel, setCurrentModel]`.
- Add `[availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([])`.
- In `onSessionUpdate` (currently switches on
  `user_message_chunk / agent_message_chunk / tool_call / tool_call_update`):
  - Add `case "available_commands_update":` →
    `setAvailableCommands(u.availableCommands)`.
  - Add `case "config_option_update":` → walk `u.configOptions`, find
    `id === "model"`, call `setCurrentModel(option.currentValue)`.
- After `dispatchAcp("session/new", ...)` in `onComposerSend`, read
  `result.configOptions` and apply the same `model` extraction so
  `currentModel` is populated before the first session/prompt round-trips.
  (`session/new` returns `configOptions` per `agent.ts:324`; same shape as
  `config_option_update`.)
- Add a helper `pushSystemMessage(text)` that appends a synthetic
  `ChatMessage` with `role: "system"`. Used by the slash dispatcher.
- Rewrite the body of `onComposerSend`:

  ```ts
  const input = composerInput.trim();
  if (!input) return;
  setComposerInput("");

  // Lazy-init guard (unchanged).
  await ensureInitialized();
  const sid = await ensureSession();

  // NEW: try local slash dispatch.
  if (isSlash(input)) {
    pushUserMessage(input); // echo into chat history before dispatch
    const outcome = await tryHandleSlash(input, {
      conn: connRef.current!,
      cwd: cwdRef.current,
      state: { sessionId: sid, availableCommands },
      pushSystemMessage,
      setSessionId: (id) => { sessionIdRef.current = id; setSessionId(id); },
      setCurrentModel,
    });
    if (outcome.handled) return;       // local — do NOT forward
  } else {
    pushUserMessage(input);
  }

  // Default path: forward to agent. (Unchanged.)
  setChatState("streaming");
  try {
    await dispatchAcp("session/prompt", { sessionId: sid, prompt: [...] });
  } finally {
    setChatState("idle");
  }
  ```

  The existing `pushUserMessage` (today inlined as `setChatMessages(prev => [...])`)
  is hoisted to a named helper so both the slash and non-slash branches
  call it once.

DOM contract is unchanged — `data-current-model` and `data-session-id`
on `chat-panel` already exist (`ChatPanel.tsx:42-43`), they just become
non-empty.

### 3. Page-object accessors

`packages/bodhi-pi/e2e-ui/pages/ChatPanel.ts` lines 44–50 currently return
the root locator from both getters. Replace with attribute readers:

```ts
async currentModel(): Promise<string> {
  return (await this.root.getAttribute("data-current-model")) ?? "";
}
async sessionId(): Promise<string> {
  return (await this.root.getAttribute("data-session-id")) ?? "";
}
```

(Functions, not getters, since `.getAttribute()` is async. Callers update
accordingly.)

### 4. New scenario fixtures

Copy from `packages/bodhi-pi-web/e2e/data/` into
`packages/bodhi-pi/e2e-ui/data/`:

```
e2e-ui/data/commands-say-tuesday/.bodhi-pi/commands/say-tuesday.md
e2e-ui/data/skills-say-hello/.bodhi-pi/skills/say-hello/SKILL.md
e2e-ui/data/extensions-redact-secrets/.bodhi-pi/extensions/redact-secrets.js
e2e-ui/data/extensions-redact-secrets/leak.txt
```

`loadScenario()` (`e2e-ui/helpers/load-scenario.ts:1`) already walks
arbitrary nested files, so no helper changes needed. Extension `.js` files
load on all four projects: `test-app-http`/`test-app-ws` go through the
e2e `createNodePackageExtensionLoader` (handles flat `.js`/`.mjs`/`.cjs`
via native dynamic import — see `e2e/helpers/extension-loaders/node-package-loader.ts:23`),
and the browser/chrome-ext projects use `createBrowserExtensionLoader`.

### 5. Write the three specs

#### `shared/model-switch.spec.ts`

Replace the `test.skip` body with a real test. Follows the
`simple-chat.spec.ts` shape:

1. `gotoStart()` → `setup.fillAndSubmit({...})`.
2. Send a no-op prompt or call `/sessions` to ensure session is initialized
   (composer must run lazy-init at least once before `/model` has a
   sessionId to bind to).
3. Read `await chat.currentModel()` — expect it to match the default
   (`gpt-4o-mini`).
4. `await chat.send("/model anthropic:claude-haiku-4-5-20251001")`.
5. Wait for the system message `model switched to:` to appear (or for
   `data-current-model` to flip — whichever lands first).
6. `expect(await chat.currentModel()).toContain("claude-haiku")`.
7. Send a follow-up prompt; assert the assistant replies (proves the new
   model is wired, not just the attribute).

Anthropic key is already loaded by `global-setup.ts:11` and exposed via
`configJson` for in-process projects.

#### `shared/session-tree.spec.ts`

One flow-style test (matches `e2e/shared/fork-clone.e2e.ts` shape):

1. Boot → send prompt → assert assistant replies (this seeds a real entry
   into the session DAG so `/fork <entryId>` has something to operate on).
2. `await chat.send("/sessions")` → expect the latest system message to
   contain `sessions:` plus the current session id substring.
3. Capture the current `sessionId()` (call it `A`).
4. `await chat.send("/clone")` → expect system message `cloned:` with a
   new id; assert it differs from `A`.
5. `await chat.send("/new")` → expect a fresh sessionId attribute, distinct
   from `A`. Send a quick prompt to confirm chat works.
6. `await chat.send("/resume " + A)` → expect attribute flips back to `A`;
   send a follow-up prompt to confirm streaming still works.
7. `await chat.send("/close")` → expect a system message confirming close.

`/fork` needs an `entryId`. Strategy: use `/entries` (or
`/tree`) once it's wired and grab the first user-message entry id from the
system message. **Alternative if `/entries` adds too much surface**: in this
commit, exercise `/fork` only via the simpler form `chat.send("/fork "
+ knownEntry)` where `knownEntry` is derived from the wire panel — wire
already records `session/update` payloads. If that proves messy, fold
`/entries` into the local registry (it's in
`bodhi-pi-browser/src/ui/commands.ts:227` already; trivial port).

#### `shared/commands-extensions-skills.spec.ts`

One flow-style test using all three new scenarios merged into a single
seed (matches `bodhi-pi-web/e2e/commands.spec.ts:1-44`):

```ts
const files = {
  ...loadScenario("commands-say-tuesday"),
  ...loadScenario("skills-say-hello"),
  ...loadScenario("extensions-redact-secrets"),
};
const seedXml = buildSeedXml(files);
```

Steps:

1. Boot with the merged seed.
2. `await chat.send("/say-tuesday")` — since `say-tuesday` IS in
   `availableCommands` (the agent emits `available_commands_update`
   after `session/new`), the local dispatcher returns
   `{ handled: false }` and the line forwards to `session/prompt`. Agent
   expands the template. Assert assistant text contains `tuesday`.
3. `await chat.send("/skill:say-hello world")` — same fallthrough path
   (skills register as `skill:<name>` commands). Assert assistant text
   contains both `hello` and `world`.
4. `await chat.send("Read the file leak.txt and tell me what's there
   verbatim.")` — exercises the extension. Per user decision **assert on
   assistant message text**: must contain `[REDACTED]` and must NOT
   contain `sk-PLAINTEXTSECRETXYZ123`. (Avoids adding tool-call card content
   rendering to `ChatPanel.tsx`.)

## Critical files

| Path | Change |
|---|---|
| `packages/bodhi-pi/e2e/app-utils/browser/ui/commands.ts` | **NEW** — local slash dispatcher (raw `ClientSideConnection`). |
| `packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx` | currentModel state, availableCommands state, `available_commands_update` + `config_option_update` cases, slash dispatch in `onComposerSend`, `pushSystemMessage` helper. |
| `packages/bodhi-pi/e2e/app-utils/browser/ui/index.ts` | Re-export `tryHandleSlash`, `isSlash`, `SlashContext` so test-apps don't need a deep import. |
| `packages/bodhi-pi/e2e-ui/pages/ChatPanel.ts` | `currentModel()` / `sessionId()` → async attribute readers. |
| `packages/bodhi-pi/e2e-ui/data/commands-say-tuesday/.bodhi-pi/commands/say-tuesday.md` | **NEW** — copied verbatim from `bodhi-pi-web/e2e/data/`. |
| `packages/bodhi-pi/e2e-ui/data/skills-say-hello/.bodhi-pi/skills/say-hello/SKILL.md` | **NEW** — copied verbatim. |
| `packages/bodhi-pi/e2e-ui/data/extensions-redact-secrets/.bodhi-pi/extensions/redact-secrets.js` | **NEW** — copied verbatim. |
| `packages/bodhi-pi/e2e-ui/data/extensions-redact-secrets/leak.txt` | **NEW** — copied verbatim. |
| `packages/bodhi-pi/e2e-ui/shared/model-switch.spec.ts` | Replace `test.skip` stub with real test. |
| `packages/bodhi-pi/e2e-ui/shared/session-tree.spec.ts` | Replace stub. |
| `packages/bodhi-pi/e2e-ui/shared/commands-extensions-skills.spec.ts` | Replace stub. |

## Reuse — what NOT to re-implement

- **`tryHandleSlash` design**: model on `bodhi-pi-browser/src/ui/commands.ts`
  (same switch shape, same precedence rule). Don't import — port the
  branches we need.
- **`buildSeedXml(loadScenario(...))`**: reused as-is via
  `e2e-ui/helpers/scenario.ts:scenarioSeedXml`. Merging multiple scenarios
  is done at the `files` map level (object-spread) before `buildSeedXml`.
- **Tool-status mapping**: `mapToolStatus` at `AppShell.tsx:352` stays.
- **Frame/event logging**: untouched; the slash path doesn't bypass it
  because every `conn.*` call goes through the same `ClientSideConnection`
  that has frame/event taps installed in `adapter.connect()`.

## Verification

Run from `packages/bodhi-pi/`:

```sh
npm run check                                      # type + lint
cd e2e-ui && npx playwright test                   # expect 28 passed, 0 skipped
cd .. && npm run test:e2e                          # all six e2e/shared projects stay green
```

Spot-check intermittently failing test the user flagged:
`packages/bodhi-pi/e2e/shared/bash.e2e.ts` under `chrome-ext` project —
re-run once if it flakes on LLM backslash rendering; confirm it's
intermittent and not a regression caused by our `AppShell` changes
(it shouldn't be, since slash dispatch only fires when input starts
with `/` and bash specs send free-form text).

Manual smoke for each host (optional, per the playbook in the migration
plan §"Manual smoke"):

```sh
cd packages/bodhi-pi/e2e/test-app-http && npm run dev   # then visit /http
cd packages/bodhi-pi/e2e/test-app-browser && npm run dev
```

Fill the setup form, then in the composer:
1. `/sessions` → should print a system message listing sessions.
2. `/model` (no arg) → should list models with `*` on the active one.
3. `/say-tuesday` (with commands-say-tuesday scenario seeded) → should
   stream `tuesday` from the agent (this proves agent-fallthrough still
   works for `availableCommands` entries).
