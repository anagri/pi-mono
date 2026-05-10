# bodhi-pi review — pi-and-web-health

**Snapshot:** 2026-05-10, HEAD `cf596f114b94`. Packages in scope: `packages/bodhi-pi`, `packages/bodhi-pi-web`. Whole-package review of architecture, implementation, clean code, test coverage, and tech debt. Every finding below has been verified against the current tree, has a concrete file:line, and is fix-now actionable. Ships as a **single commit** per user direction.

---

## Batch A — Type-safety drift in ACP/notification handling

CLAUDE.md mandates "No `as` casts in ACP message handling. Narrow on `role` via pi-ai's `Message` discriminator." The boundary leaks in both packages.

**A.1** Type guards in `notifications.ts` cast `AgentMessage` through `{ role?: unknown }` instead of narrowing on `pi-ai`'s typed `role` discriminator.
- `packages/bodhi-pi/src/acp/notifications.ts:6` `(msg as { role?: unknown }).role === "toolResult"`
- `packages/bodhi-pi/src/acp/notifications.ts:11`, `:22`, `:24`, `:33`, `:87`
- Replace with discriminator narrowing: `(msg.role === "assistant")` reads cleanly because `AgentMessage` is `pi-ai`'s discriminated union; only `extractText`'s `user` branch needs a guard for the `string | TextContent[]` content-shape.

**A.2** `BodhiPiAcpAgent.subscribeToAgent` re-casts the assistant message to a hand-typed `{ stopReason?, errorMessage? }` rather than narrowing on `event.message.role` — direct violation of the CLAUDE.md rule.
- `packages/bodhi-pi/src/acp/agent.ts:577` `event.message as { stopReason?: PiStopReason; errorMessage?: string }`
- Narrow first (`if (event.message.role !== "assistant") return;`) then read `.stopReason` and `.errorMessage` off the typed `AssistantMessage`.

**A.3** `dispatchNotification` in the web host wholesale-casts the SDK's discriminated `SessionNotification.update` to `Record<string, unknown>` and recovers each field with per-call `as` — every typed shape from `@agentclientprotocol/sdk` is discarded.
- `packages/bodhi-pi-web/src/agent/render.ts:47-92` (13 `as` casts; see `:47`, `:48`, `:51`, `:60`, `:68`, `:74`, `:76`, `:78`, `:90`, `:92`)
- Switch on `notif.update.sessionUpdate` (the SDK's literal-tagged discriminator) and let TS narrow each branch; drop `mapStatus(string | undefined)` in favour of the SDK's `ToolCallStatus`.

**A.4** Slash-command dispatcher casts SDK responses to weakly-typed shapes that drift from `setSessionConfigOption` and `listSessions` return types.
- `packages/bodhi-pi-web/src/ui/commands.ts:85` `result.configOptions[0]?.currentValue as string | undefined`
- `packages/bodhi-pi-web/src/ui/commands.ts:97` casts `result.sessions` to a hand-typed array
- `packages/bodhi-pi-web/src/ui/commands.ts:147` same pattern as `:85`
- Use the SDK's `SetSessionConfigOptionResponse` / `ListSessionsResponse` return types directly.

---

## Batch B — Cross-runtime path portability

bodhi-pi is runtime-agnostic and treats every host path as POSIX. Two call sites silently fall back to platform default and would misbehave on a Windows host.

**B.1** `resolvePath` uses platform-default `path.isAbsolute`, then `path.posix.normalize`. On Windows, `path.isAbsolute("/foo")` is `false`, so an LLM-emitted absolute POSIX path is re-joined under `cwd`.
- `packages/bodhi-pi/src/tools/index.ts:39` — `path.isAbsolute(userPath)` → `path.posix.isAbsolute(userPath)`.

**B.2** `walk`'s default skip-dir uses platform-default `path.basename` while the rest of the file uses `path.posix.join`.
- `packages/bodhi-pi/src/tools/walk.ts:21` — `path.basename(absolutePath)` → `path.posix.basename(absolutePath)`.

---

## Batch C — Bounded-truncation contract drift

CLAUDE.md calls out `accumulateBounded` as canonical for `ls`/`find`/`grep` and says `read.ts` is the byte-aware exception. The truncation contract is inconsistent in three places.

**C.1** `accumulateBounded`'s `maxBytes` accumulator counts UTF-16 code units (`item.length`), but the helper's docstring and `truncationFooter`'s reason string both report "KB" / "byte cap". Multi-byte payloads (CJK, emoji) under-report by 2–4×.
- `packages/bodhi-pi/src/tools/_accumulate.ts:42` `bytes + item.length + 1 > maxBytes`
- `packages/bodhi-pi/src/tools/_accumulate.ts:46` `bytes += item.length + 1`
- `packages/bodhi-pi/src/tools/_accumulate.ts:80` reason string says "KB output limit"
- Either rename `maxBytes` → `maxChars` and update the footer wording, or measure with `Buffer.byteLength(item, "utf-8") + 1`.

**C.2** `read`'s byte-cap path slices a UTF-8 buffer at an arbitrary offset and re-decodes — the tail row gets a `�` replacement character whenever the cut lands mid-multibyte.
- `packages/bodhi-pi/src/tools/read.ts:43` `Buffer.from(selected, "utf-8").subarray(0, READ_MAX_BYTES).toString("utf-8")`
- Truncate by re-walking the joined string from the start, accumulating `Buffer.byteLength(line) + 1` until the cap is reached, and joining only complete lines.

**C.3** `find` and `grep` hard-code `maxEntries: 50_000` for `walk` instead of pulling from `tools/limits.ts` like every other tool cap.
- `packages/bodhi-pi/src/tools/find.ts:33`
- `packages/bodhi-pi/src/tools/grep.ts:52`
- Add `WALK_MAX_ENTRIES = 50_000` to `tools/limits.ts:14` and import.

---

## Batch D — Module structure & docs drift

**D.1** `mergeTools` and `mergeCommands` are pure functions with no relationship to `ExtensionRunner` but live in the runner's class file. Caller (`agent.ts`) imports them alongside the class, blurring the module boundary.
- `packages/bodhi-pi/src/extensions/runner.ts:184-193`
- Move to a dedicated `extensions/merge.ts` (or `tools/index.ts` if you prefer collation alongside `createBuiltinTools`).

**D.2** `createRunScriptTool` factory signature diverges from every peer tool factory (`(deps: ToolDeps)` → `({ executor, cwd })`), forcing a bespoke prop-mapping at the single call site.
- `packages/bodhi-pi/src/tools/run-script.ts:26` `({ executor, cwd }: CreateRunScriptToolOptions)`
- `packages/bodhi-pi/src/tools/index.ts:29` ad-hoc `{ executor: deps.scriptExecutor, cwd: deps.cwd }`
- Take `(deps: ToolDeps)`; assert `deps.scriptExecutor` at the top of `execute` (factory is only called when present per `:28`).

**D.3** `EXT_DELETE_SESSION` is defined as a constant in core but **not** re-exported, so the web host hard-codes the wire string. Any rename silently desyncs.
- `packages/bodhi-pi/src/acp/constants.ts:5` (defined)
- `packages/bodhi-pi/src/index.ts:1-61` (not exported)
- `packages/bodhi-pi-web/src/ui/commands.ts:12` `const EXT_DELETE_SESSION = "_bodhi-pi/session/delete"`
- Re-export from `bodhi-pi/src/index.ts` and import in the web host.

**D.4** CLAUDE.md key-files table points to a directory that does not exist; the actual layout is `src/commands/`. Also rewrite the M5.2 paragraph (line 77) and the "Tests bypass the FSA picker via seed injection" pillar (line 19) once Batch F lands — the `__bodhiPiEventLog` / `recordEvents` story disappears.
- `packages/bodhi-pi/CLAUDE.md:62` `src/slash-commands/` → `src/commands/`
- `packages/bodhi-pi-web/CLAUDE.md:19` and `:77` — drop `recordEvents` references; document `<EventsPanel>` and the lifecycle/wire tabs.

---

## Batch E — Async/error-contract gaps

**E.1** `pi.events` bus's `void h(data)` discards a returned `Promise`, so handlers that throw asynchronously surface as unhandled rejections rather than the documented `console.error` log. The surrounding `try/catch` only catches synchronous throws.
- `packages/bodhi-pi/src/extensions/events-bus.ts:11-15`
- Replace with `Promise.resolve(h(data)).catch((err) => console.error(...))` (drop the `try/catch`).

**E.2** `mapStopReason` accepts `PiStopReason | undefined` (where `PiStopReason` includes `"error"`), but `"error"` falls through to the `default` arm and silently returns `"end_turn"`. The doc comment says callers handle `"error"` separately — the type does not.
- `packages/bodhi-pi/src/acp/notifications.ts:95-117`
- Either narrow the parameter to `Exclude<PiStopReason, "error"> | undefined`, or add `case "error": throw new Error("mapStopReason called on error stop reason");` so a future refactor can't silently regress to `end_turn`.

---

## Batch F — Replace e2e whitebox channels with an always-on events sidepanel

bodhi-pi-web is a **reference / test host, not a production app** — purpose-built test affordances belong in the UI itself. Today's e2e suite reaches into `window` and calls `page.evaluate` to read state the page never exposes; that is the one whitebox bridge to retire. The sole exemption is the FSA seed (`__bodhiPiWebSeed`) which has no DOM-side alternative — that one stays and gets called out explicitly in `seed.ts`'s docstring as the boundary.

**F.1** Add `<EventsPanel>` mounted next to `<ChatPage>` in `App.tsx` (always visible — no flag, no toggle, no route gate). Two tabs:
- **Lifecycle** — the 19 bodhi-pi events the worker already produces via `recordingHandlers()`.
- **ACP wire** — every JSON-RPC frame crossing the `MessagePort` in either direction (request, response, notification, error).

Each row exposes attributes for blackbox assertion; no spec needs `page.evaluate` again:
- `data-testid="event-row"`
- `data-event-source="lifecycle" | "wire"`
- `data-event-type="<name>"` (e.g. `tool_call`, `sessionUpdate`, `session/new`)
- `data-event-direction="in" | "out"` (wire only)
- `data-session-id`, `data-tool-name` etc. mirrored from today's `WorkerEventMessage["record"]` shape so the existing field-level assertions translate one-to-one.
- Body of the row carries the JSON payload as text for `toContainText` matchers.

**F.2** Capture ACP wire frames by tee'ing the streams once per side. The existing `ndJsonStream(writable, readable)` calls in `runtime.ts:79` (main) and `worker.ts:97-98` (worker) are wrapped with a `TransformStream` that fans out a copy of every frame to a per-side `postMessage` channel. Worker-side wire records ride the same `self.postMessage({ type: "bodhi-pi-event", ... })` channel as today's lifecycle events; main-side wire records dispatch directly into the panel store. No SDK change.

**F.3** Remove the entire `recordEvents` plumbing — it becomes always-on and stops being a flag.
- `packages/bodhi-pi-web/src/agent/types.ts:18-25` drop `recordEvents` from `InitMessage`.
- `packages/bodhi-pi-web/src/agent/runtime.ts:34-39` drop `recordEvents` from `RuntimeOptions`; collapse the conditional `worker.addEventListener` block at `:66-76`.
- `packages/bodhi-pi-web/src/agent/runtime.ts:13-17, 70-71` delete the `Window.__bodhiPiEventLog` augmentation and the array-init code.
- `packages/bodhi-pi-web/src/agent/worker.ts:69, 93` drop the `recordEvents` destructure and the conditional `eventHandlers` injection — always register handlers.
- `packages/bodhi-pi-web/src/workspace/bootstrap.ts:11, 31-42, 53, 65` drop `__bodhiPiWebRecordEvents`, `readRecordEventsFlag`, the `recordEvents` field on `BootstrapResult`.
- `packages/bodhi-pi-web/src/ui/RuntimeProvider.tsx:34, 39, 62, 76, 142` drop the `recordEvents` prop and pass-through.
- `packages/bodhi-pi-web/src/App.tsx:32, 70` drop the `recordEvents` arg.

**F.4** Replace `events.spec.ts` whitebox reads with panel locators.
- `packages/bodhi-pi-web/e2e/events.spec.ts:15-17` delete the `readLog` / `page.evaluate` helper.
- `packages/bodhi-pi-web/e2e/events.spec.ts:34-37` delete the `__bodhiPiEventLog` existence check (panel mount is the existence check).
- Rewrite `:41, :50-72, :79-90, :96-97, :114-119` to use `page.locator('[data-testid="event-row"][data-event-type="..."]')` and `toHaveAttribute` / `toContainText`. Add a `EventsPanel` page object alongside `ChatPage` in `e2e/pages/`.

**F.5** Trim `seed.ts` to the FSA exemption only.
- `packages/bodhi-pi-web/e2e/helpers/seed.ts:24-28` drop the `__bodhiPiWebRecordEvents` injection; keep `__bodhiPiWebSeed` and rewrite the docstring (`:7-17`) to flag this as the **only** sanctioned whitebox bridge — kept because no DOM affordance can substitute for the FSA picker bypass.

**F.6** No other whitebox bridges found in the e2e suite. `extensions.spec.ts:28` uses a CSS selector instead of the POM but reads the DOM (already blackbox); `sessions.spec.ts:85`'s `chat.page.reload()` is a normal Playwright pattern. Sweep verified by `grep -rn "window\\.\\|page.evaluate" packages/bodhi-pi-web/e2e` — only the events-log reads light up.

---

## Suggested commit

Single commit covering Batches A through F. Bundle order keeps build green between hunks but is not separable per the user's direction:

1. Core type-safety + path + truncation + module fixes (Batches A–E) — pure refactor, no behavioural change.
2. Web `EventsPanel` + stream tee (F.1, F.2) — additive UI + plumbing.
3. Strip `recordEvents` flag end-to-end (F.3) — only safe **after** F.1/F.2 land.
4. Rewrite `events.spec.ts` against panel locators + trim `seed.ts` (F.4, F.5).
5. CLAUDE.md updates from D.4 (post-rewrite of the `recordEvents` story).

Commit message theme: `refactor(bodhi-pi,web): tighten ACP types, fix POSIX paths, replace e2e whitebox bridges with EventsPanel`.
