# Migrate Playwright UI tests from bodhi-pi-* to bodhi-pi/e2e-ui

## Context

Playwright UI coverage is **forked three ways** across the reference hosts:

| Suite | Specs | Driven host |
|---|---|---|
| `packages/bodhi-pi-web/e2e/` | 21 | bodhi-pi-web Vite dev server |
| `packages/bodhi-pi-chrome-ext/e2e/` | 21 (mirrored from web) | MV3 extension build |
| `packages/bodhi-pi-ws-frontend/e2e/` | 27 (`m*-`-prefixed) | ws-frontend + spawned ws-server |

Each suite owns its own page objects, fixtures, and web-server orchestration —
a triple maintenance burden. The `e2e/shared/` Vitest model already solved
the same problem at the ACP level: one set of `*.e2e.ts` specs runs across
`in-memory / cli / http / ws / browser / chrome-ext` via `createE2EHarness()`.
The Playwright (UI) tier never got that treatment.

**Goal:** create `packages/bodhi-pi/e2e-ui/` — one Playwright config whose
projects (`http`, `ws`, `browser`, `chrome-ext`) all run the same set of specs
against the existing `e2e/test-app-*` packages. Once green, the three forked
Playwright suites become deletable in a follow-up.

**Design decisions (resolved with the user up-front):**

1. Shared UI lives **inside the existing `e2e/app-utils/browser/` tree** under
   a new `ui/` subdirectory — not a new top-level workspace. The test-apps
   already import from `@e2e/app-utils/browser/*` via tsconfig path alias;
   the `tsconfig.frontend.json` `include` glob only needs widening from
   `**/*.ts` → `**/*.{ts,tsx}`. No new npm workspace, no new package.json.
2. Three explicit panels: **Chat | Wire | Events**, left-to-right. Not tabs.
3. **No new `test-app-ws` package.** `test-app-http` exposes both transports
   at different routes (`/http`, `/ws`) with a header toggle, reusing one
   React app.
4. Workspace seeding via the existing `<files>...</files>` XML textarea —
   battle-tested in `e2e/shared`, handles dotfiles cleanly, sidesteps
   Chromium's `webkitdirectory` flakiness. Specs build the XML from a
   scenario directory on disk via `buildSeedXml(loadScenario(name))`.
5. **Modify existing screens in place.** The current screens in
   `test-app-browser` and `test-app-chrome-ext` are already driven by
   `e2e/shared`'s browser/chrome-ext harnesses — we evolve them. The
   `test-app-http` UI is not used by `e2e/shared` (the http harness talks
   raw HTTP+SSE), so it's freely redesigned.

`in-memory` has no UI → no Playwright project. `cli` is deferred — `terminal`
spec stays on the table only because it tests the built-in bash tool,
not a terminal UI.

## Shape of the change

The shared UI is the seam. Four Playwright projects each spawn a different
host but read the same DOM contract, so 7 specs × 4 projects = 28 runs from
one source.

```
            ┌─────────────────────────────────────────────────────────┐
            │ NEW: e2e/app-utils/browser/ui/                          │
            │   SetupForm.tsx   ─┐                                    │
            │   DevAcpIo.tsx     │ (existing test-app-browser/        │
            │   WirePanel.tsx    │  test-app-chrome-ext markup        │
            │   EventsPanel.tsx ─┘  extracted verbatim)               │
            │   ChatPanel.tsx       (NEW composer + tool-cards)       │
            │   TransportToggle.tsx (NEW, test-app-http only)         │
            │   AppShell.tsx        (composes the above)              │
            │   transport.ts        (TransportAdapter interface)      │
            └────────┬───────────────┬─────────────────────┬──────────┘
                     │               │                     │
        ┌────────────▼───┐  ┌────────▼──────────┐  ┌───────▼────────────┐
        │ test-app-      │  │ test-app-         │  │ test-app-http      │
        │   browser      │  │   chrome-ext      │  │  (Vite frontend +  │
        │   /App.tsx     │  │   /App.tsx        │  │   Node server)     │
        │   (~30 LoC,    │  │   (~30 LoC,       │  │   /App.tsx (~50    │
        │    MsgPort     │  │    MsgPort+sandbox│  │    LoC, picks      │
        │    adapter)    │  │    adapter)       │  │    http vs ws by   │
        └────────┬───────┘  └─────────┬─────────┘  │    URL route)      │
                 │                    │            └──────────┬─────────┘
                 │  Playwright project              ┌─────────┴────────┐
                 ▼                    ▼             ▼                  ▼
            ┌─────────┐   ┌──────────────────┐  ┌────────┐         ┌────────┐
            │ browser │   │   chrome-ext     │  │  http  │         │   ws   │
            └────┬────┘   └────────┬─────────┘  └────┬───┘         └────┬───┘
                 └────────┬────────┴──────────┬─────┴──────────┬───────┘
                          ▼                                    ▼
                  ┌─────────────────────────────────────────────────┐
                  │ e2e-ui/shared/*.spec.ts (the SAME 7 specs)      │
                  └─────────────────────────────────────────────────┘
```

## DOM contract — preserved + extended

The chat surface is new; the frame/event surfaces stay **byte-compatible**
with the existing test-app-browser/chrome-ext DOM so `e2e/shared` keeps
passing throughout the migration.

| Element | Status | Selector |
|---|---|---|
| Root | existing | `[data-testid="test-app-root"][data-test-state="needs-init"\|"ready"\|"streaming"\|"closed"\|"error"]` |
| Setup form | existing | `setup-form`, `user-id`, `user-email`, `seed-files`, `config`, `setup-submit` |
| Workspace root pill | existing | `[data-testid="workspace-root"]` |
| Dev ACP I/O (kept for `e2e/shared`) | existing | `acp-io`, `acp-input`, `acp-submit`, `acp-cancel` |
| Wire panel wrapper | **NEW wrapper, rows unchanged** | `[data-testid="wire-panel"]` wraps existing `[data-testid="frame-log"]`; rows stay `[data-testid="frame"][data-frame-direction][data-frame-kind][data-frame-method][data-frame-rpc-id][data-frame-seq]` |
| Events panel wrapper | **NEW wrapper, rows unchanged** | `[data-testid="events-panel"]` wraps existing `[data-testid="event-log"]`; rows stay `[data-testid="event"][data-event-type][data-event-seq]` |
| Chat panel | NEW | `[data-testid="chat-panel"][data-test-state="idle"\|"streaming"][data-current-model][data-session-id]` |
| Chat message | NEW | `[data-testid="chat-message"][data-message-role="user"\|"assistant"\|"system"]` |
| Tool-call card | NEW | `[data-testid="tool-call"][data-tool-name][data-tool-status="running"\|"completed"\|"failed"]` |
| Composer | NEW | `[data-testid="composer-input"]`, `[data-testid="composer-send"]` (morphs to stop while streaming) |
| Transport toggle (test-app-http only) | NEW | `[data-testid="transport-toggle"][data-current="http"\|"ws"]` |

Crucially: the existing `frame` / `event` row testids and their `data-frame-*`
/ `data-event-*` attributes are **not renamed**. New `wire-panel` /
`events-panel` testids are added as **wrappers** around them.

The dev `acp-io` panel stays **visible** post-submit (a thin strip below
the 3-panel grid). `e2e/shared`'s harness needs it interactable.

### Init policy: lazy chat init

`e2e/shared`'s `BrowserAcpConnection` drives `initialize` → `session/new` →
`session/prompt` itself via the `acp-input` textarea. If form-submit code
auto-initialized, `e2e/shared`'s own `initialize` call would error.

Resolution: **the chat composer initializes lazily on first send.** On form
submit, the test-app just constructs the `ClientSideConnection` and flips
state to `ready`. The composer's first send runs
`initialize` → `session/new` → `session/prompt` if no sessionId yet.
`e2e/shared` never touches the composer.

## Architecture

### Shared UI: `packages/bodhi-pi/e2e/app-utils/browser/ui/`

Exports:

```ts
// @e2e/app-utils/browser/ui/index.ts
export { SetupForm }        // existing form testids, verbatim
export { DevAcpIo }         // existing acp-io / acp-input / acp-submit / acp-cancel
export { WirePanel }        // wraps existing frame-log
export { EventsPanel }      // wraps existing event-log
export { ChatPanel }        // NEW — composer, message list, tool-call cards
export { TransportToggle }  // NEW — test-app-http header pill
export { AppShell }         // composes the above into form + 3-panel layout
export type { TransportAdapter, ChatMessage, ToolCall }
```

`AppShell`:
1. `state === "needs-init"`: just `<SetupForm>`.
2. After submit: header row (workspace-root pill + transport-toggle slot) +
   3-column grid (`<ChatPanel>` | `<WirePanel>` | `<EventsPanel>`) +
   `<DevAcpIo>` strip pinned at bottom (visible).

`TransportAdapter`:

```ts
interface TransportAdapter {
  conn: ClientSideConnection;
  onUpdate(cb: (n: SessionNotification) => void): () => void;
  onFrame(cb: (f: FrameEntry) => void): () => void;
  onEvent(cb: (e: EventEntry) => void): () => void;
  workspaceRoot(): string;
}
```

**tsconfig change:** each test-app's `tsconfig.frontend.json` widens
`include` glob from `**/*.ts` → `**/*.{ts,tsx}`.

### `packages/bodhi-pi/e2e-ui/`

```
e2e-ui/
├── package.json              # private; registers as workspace
├── playwright.config.ts      # projects: http, ws, browser, chrome-ext
├── global-setup.ts           # OPENAI_API_KEY (+ ANTHROPIC_API_KEY for model-switch)
├── tsconfig.json
├── shared/                   # the 7 specs
│   ├── simple-chat.spec.ts
│   ├── tool-call.spec.ts
│   ├── model-switch.spec.ts
│   ├── workspace-fs.spec.ts
│   ├── commands-extensions-skills.spec.ts
│   ├── terminal.spec.ts
│   └── session-tree.spec.ts
├── pages/
│   ├── SetupForm.ts
│   ├── ChatPanel.ts
│   ├── WirePanel.ts
│   └── EventsPanel.ts
├── fixtures.ts
├── helpers/
│   ├── projects/
│   │   ├── http.ts
│   │   ├── ws.ts
│   │   ├── browser.ts
│   │   └── chrome-ext.ts
│   ├── seed-xml.ts           # re-export from e2e/helpers/browser/seed-xml
│   ├── load-scenario.ts
│   └── prompts.ts
└── data/                     # scenario fixtures
```

### The 7 specs

| Spec | Coverage |
|---|---|
| `simple-chat.spec.ts` | composer.send("what day after Monday?") → "tuesday"; state cycles `idle→streaming→idle`; wire shows `session/prompt` + `session/update`; events shows `agent_start`+`agent_end`. |
| `tool-call.spec.ts` | Seed `fs-tools-notes-txt`, prompt → tool-call card `completed`; wire records tool-call/tool-result. |
| `model-switch.spec.ts` | Both providers seeded; `/model anthropic:...` updates `data-current-model`. |
| `workspace-fs.spec.ts` | Form-seed multi-file workspace; agent lists/reads; assert via card+text. |
| `commands-extensions-skills.spec.ts` | Form-seed `.bodhi-pi/{commands,skills,extensions}`; verify all three. |
| `terminal.spec.ts` | Built-in bash tool — prompt forces shell command, assert card+frames. |
| `session-tree.spec.ts` | `/fork`, `/clone`, `/sessions`, reload+resume; session-id transitions. |

Skipped: cancel button (gpt-4o-mini finishes too fast), cross-provider parity
(covered by `model-switch`), per-host ergonomics.

### test-app-http server: `POST /provision`

```
POST /provision
Body: { id: number, email: string, seedXml: string }
→  { token: string, workspaceRoot: string }
```

Reuses existing `ensureUserWorkspace`, `encodeToken`, and `parseSeedFiles`.

`e2e/shared` http/ws Vitest projects don't go through `/provision` (raw
protocol), no impact.

### How `e2e/shared` survives

| Harness file | Selectors used | Status |
|---|---|---|
| `page-setup.ts` | `setup-form`, `user-id`, `user-email`, `seed-files`, `config`, `setup-submit`, root state | unchanged |
| `acp-connection.ts` | `acp-input`, `acp-submit`, `acp-cancel` | unchanged (`<DevAcpIo>`) |
| `page-frame-reader.ts` | `frame-log`, `frame[data-frame-*]`, `event-log`, `event[data-event-*]` | unchanged (wrappers added around) |
| `seed-xml.ts`, `load-fixture-seed-files.ts` | XML format | unchanged |

## Phasing (depth-first per runtime)

Each commit ends with **both** the touched runtime's `e2e/shared` project AND
its new `e2e-ui` project green.

### Commit 1 — Foundation: extract `app-utils/browser/ui/`

- Create `e2e/app-utils/browser/ui/` with `SetupForm`, `DevAcpIo`,
  `WirePanel` (wraps `frame-log`), `EventsPanel` (wraps `event-log`).
  **No chat surface yet.** No DOM changes — byte-identical.
- Widen `tsconfig.frontend.json` glob to `**/*.{ts,tsx}` in
  `test-app-browser` + `test-app-chrome-ext`.
- `test-app-browser`/`test-app-chrome-ext` `App.tsx` switch to consume
  the new components.
- Scaffold `packages/bodhi-pi/e2e-ui/` (config, setup, fixtures, empty
  pages, no specs yet). Register in root `package.json` workspaces.
- **Gate:** `e2e/shared` browser+chrome-ext green; playwright smoke loads.

### Commit 2 — Add `ChatPanel` + extend `AppShell`

- Add `<ChatPanel>`, `<AppShell>` to `app-utils/browser/ui/`.
- Lazy-init: composer's first send runs initialize→newSession→prompt.
- Wire MessagePort adapter to forward `session/update` to chat store
  **in addition** to existing frame log.
- **Gate:** `e2e/shared` browser+chrome-ext still green. No `e2e-ui`
  specs yet.

### Commit 3 — `http` project green

- Retrofit `test-app-http`: replace `src/frontend/components/*` and
  `App.tsx` with `<AppShell>`. Add `/http` path-aware routing.
  Add `POST /provision` route.
- Build HTTP+SSE `TransportAdapter`.
- Write all 7 specs in `e2e-ui/shared/`.
- **Gate:** `npx playwright test --project=http` green.

### Commit 4 — `ws` project green

- Add `/ws` route + `<TransportToggle>` in header.
- Build WebSocket `TransportAdapter`.
- Add `ws` Playwright project; same 7 specs pass.
- **Gate:** http+ws Playwright green; `e2e/shared` ws green.

### Commit 5 — `browser` project green

- Browser adapter exists from Commit 2. Enable browser Playwright project.
- **Gate:** `--project=browser` green; `e2e/shared` browser+chrome-ext green.

### Commit 6 — `chrome-ext` project green

- Enable chrome-ext Playwright project.
- **Gate:** full Playwright run (28 specs) + full `e2e/shared` green.
  Matrix complete.

CLI deferred. After Commit 6, legacy `bodhi-pi-*` Playwright suites become
deletable in follow-up.

## Verification

1. **Type check & lint.** Root `npm run check`.
2. **`e2e/shared` survives.** From `packages/bodhi-pi/`:
   `npm run test:e2e -- --project=browser --project=chrome-ext` green
   at every commit touching test-app-browser/chrome-ext.
3. **Per-project Playwright run.** Incremental project additions per commit.
4. **Manual smoke.** Per-host `npm run dev`, form-fill, send "what day
   after Monday?", confirm panels populate.
5. **Matrix gate (Commit 6).** Full Playwright + full `e2e/shared` green.

Required env: `OPENAI_API_KEY` always; `ANTHROPIC_API_KEY` for `model-switch`.
Conventional model: `gpt-4o-mini`. Assert stable substrings, not exact text.
