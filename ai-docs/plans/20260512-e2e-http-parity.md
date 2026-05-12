# Get http parity on all shared e2e — remove the two `runIf(!isRuntime("http"))` skips

## Context

After Phase 4 the consolidated e2e runs 39 tests across three projects. Two are skipped under `http`:

1. `e2e/shared/chat.e2e.ts` — `"switching model mid-session changes provenance"`.
2. `e2e/shared/tree-navigate.e2e.ts` — `"/tree + /goto"`.

The user wants these running under `http` so we have full cross-runtime parity. This plan starts from the architectural root cause (why `http` even needs special handling that the other runtimes don't) and ends with concrete code changes.

## Architectural root cause: a stateful protocol on a stateless transport

ACP, as designed and as zed implements it ([01-zed-acp-architecture.md](../research/zed/01-zed-acp-architecture.md)), assumes a **stateful agent**: the client spawns the agent as a long-running process, calls `initialize`, then `session/new` (or `session/load`), then issues a stream of method calls (`prompt`, `setSessionConfigOption`, extension methods, …) against the same in-memory session. The agent keeps the session in `this.sessions` between calls. State is only persisted to disk so it survives across **agent restarts** (via `session/load`).

Every other bodhi-pi reference host follows this pattern:
- `bodhi-pi-cli` keeps the agent in-process; the REPL loop is one agent for many user inputs.
- `bodhi-pi-web` keeps the agent in a Web Worker that lives as long as the tab.
- `bodhi-pi-ws-server` keeps a per-connection agent that lives while the WS is open.
- The new `test-app-cli --rpc` mode (cli e2e) keeps the agent alive for the duration of the spawned child process.

`bodhi-pi-http` is the odd one out (intentionally). Its CLAUDE.md spells this out: **"Each turn = one HTTP request. Agent is built fresh from persisted state, runs the turn, tears down."** The HTTP host runs a *stateless deployment* of a *stateful protocol*. Between any two HTTP calls touching the same session, the agent has zero in-memory state. To make the spec-stateful agent work on a stateless transport, `packages/bodhi-pi-http/src/server/acp/handler.ts` keeps a hand-maintained `NEEDS_REHYDRATE` set (line 164):

```ts
const NEEDS_REHYDRATE = new Set([
  "session/setSessionConfigOption",
  "_bodhi-pi/session/compact",
  "_bodhi-pi/session/setName",
  "_bodhi-pi/session/config",
  "_bodhi-pi/session/settings/get",
  "_bodhi-pi/session/settings/set",
  "_bodhi-pi/session/settings/unset",
  "_bodhi-pi/session/settings/list",
]);
if (NEEDS_REHYDRATE.has(body.method)) {
  const sid = (params as { sessionId?: unknown }).sessionId;
  if (typeof sid === "string" && agent.resumeSession) {
    await agent.resumeSession({ sessionId: sid, cwd: wired.cwd, mcpServers: [] } as never);
  }
}
```

If the dispatched method reads `this.sessions.get(sessionId)`, it must appear in this set, otherwise the get returns `undefined` and the handler short-circuits or throws. The set is the **contract between bodhi-pi's stateful agent and bodhi-pi-http's stateless deployment**.

The set has rotted: as bodhi-pi grew extension methods, several that touch in-memory session state weren't added. The two e2e tests that skip under `http` are surfacing exactly that rot.

## Bug 2 (tree-navigate) — high-confidence diagnosis

### The test

```ts
const nav = await h.client.navigateSession({ sessionId, targetEntryId: firstUserId });
// Cross-branch /goto auto-appends a branch_summary; leafId points there now.
expect(nav.leafId).not.toBe(firstUserId);
```

The test does two prompts, picks the first user entry's id, then navigates back to it. Cross-branch navigate is supposed to auto-append a synthetic `branch_summary` entry to the DAG; the response's `leafId` is the id of that auto-appended entry.

### Why it fails under http

Walk-through of `handleSessionNavigate` in `packages/bodhi-pi/src/acp/agent.ts` (~line 982):

```ts
const session = this.sessions.get(sessionId);
const oldLeaf = session?.runtime.leafId ?? record.leafId ?? null;
// ... compute cross-branch flag ...
if (cross && session && oldLeaf) {
  // append branch_summary entry, return new leafId
}
// fall-through: just store targetEntryId as the new leafId, return it
```

Under in-process / cli runtimes, `session` is populated from a prior call (newSession or prompt) — `this.sessions` holds it. The `if` branch runs, branch_summary is appended, and the response's `leafId` is the new entry's id.

Under bodhi-pi-http per-turn rebuild, the agent for this request is fresh. `this.sessions` is empty. `session = undefined`. The `if` fails. The fall-through stores `targetEntryId` as `leafId` and returns it. So the test's `nav.leafId !== firstUserId` assertion fails because `nav.leafId === firstUserId`.

### Why `_bodhi-pi/session/navigate` isn't in `NEEDS_REHYDRATE`

Pure omission. When navigate landed, its in-memory-state dependency wasn't carried into the http handler's set. Other comparable handlers (`compact`, `setName`, etc.) did get added.

### The fix

Add `_bodhi-pi/session/navigate` to `NEEDS_REHYDRATE`. The rehydrate path is already implemented (`agent.resumeSession({sessionId, cwd, mcpServers: []})` populates `this.sessions`). After rehydration the existing `if (cross && session && oldLeaf)` block runs normally.

## Bug 1 (chat model-switch) — diagnosis less certain; root cause needs runtime confirmation

### The test

```ts
const claudeResult = await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: provenancePrompt }] });
// expect claude provenance ("anthropic"/"claude") — passes

const switchResult = await h.clientConn.setSessionConfigOption({ sessionId, configId: "model", value: gpt.id });
// returned switched.currentValue === gpt.id — passes

const gptResult = await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: provenancePrompt }] });
// expect gpt provenance ("openai"/"gpt"/"chatgpt") — FAILS under http with "anthropic" in the response
```

The fact that `switchResult.currentValue === gpt.id` passes means `setSessionConfigOption` ran correctly. The model_change entry was persisted with `modelId = gpt.id`. The fact that the next `prompt` came back with anthropic-flavored content means the **agent that ran the second prompt was still using claude as its provider** (or claude responded saying "anthropic", which seems unlikely given the test passes everywhere else).

### What we verified by code-read (it all looks correct)

The setSessionConfigOption flow under http:
1. Handler hits the `NEEDS_REHYDRATE.has("session/setSessionConfigOption")` branch and calls `agent.resumeSession({sessionId, cwd})`. → populates `this.sessions` with the session reconstructed from storage.
2. Dispatch to `agent.setSessionConfigOption(params)` (`agent.ts:1249`). Gets `session` from `this.sessions` (post-rehydrate, present). Calls `setSessionModel(sessionId, session, value)`.
3. `setSessionModel` (`agent.ts:1264`):
   - Mutates `session.runtime.piAgent.state.model = newModel`.
   - Mutates `session.runtime.currentModelId = value`.
   - Appends a `model_change` SessionEntry with `provider: newModel.provider, modelId: newModel.id`.
4. `appendEntry` (`agent.ts:370`) writes to `sessionStore.append` then `sessionStore.setLeafId`. better-sqlite3 is synchronous → durable before the HTTP response goes out.

The next prompt under http:
1. Handler hits `handleSseMethod` → `agent.resumeSession({sessionId, cwd})`.
2. `resumeSession` (`agent.ts:527`) → `rehydrateSession(sessionId, cwd)` (`agent.ts:1752`):
   - Loads the SessionRecord. `record.leafId` is the model_change entry's id.
   - `buildSessionContext(record)` walks the DAG from `record.leafId` via parentId. The path includes the model_change entry.
   - In the iteration (`build-context.ts:92-94`) the model_change is read: `currentModelId = entry.modelId` → `gpt.id`.
   - `requested = ctx.currentModelId ?? this.config.defaultModelId` → `gpt.id`.
   - `_resolveSessionModel(gpt.id)` finds gpt in `allModels()` (`config.models` was `[claude, gpt]` at boot) → returns gpt.
   - `_buildSessionState(..., restoredModel = gpt, ...)` builds the piAgent with gpt and stores it in `this.sessions`.
3. Agent's `prompt` runs against `session.runtime.piAgent` which has gpt set.

So **by static reading, the second prompt should route to gpt under http**. But the e2e empirically reports claude-flavored content. Three possibilities:

1. **A subtle code bug we missed.** Some step above does not behave as the source reads. Most likely candidates if there's a real bug: `buildSessionContext` (does the DAG walk see the model_change?), `_resolveSessionModel` (does it return the requested model when host-config supplies it?), or `_buildSessionState` (does it use `restoredModel`?).
2. **Test prompt sensitivity.** `gpt-5-mini` is asked "Are you made by Anthropic or by OpenAI? Answer with exactly one of those two words and nothing else." The previous turn in the session contains claude's reply ("Anthropic", "I am Claude"). Under http the prompt's context comes from message replay during rehydrate. The replayed history conditioning might cause gpt to mirror the previous answer. Under in-memory / cli, the session keeps the in-process Agent — different state, different conditioning.
3. **Provider-response noise.** The "anthropic" string is somewhere in the gpt reply by accident (e.g. "I'm not made by Anthropic; I'm made by OpenAI" — the test's `.includes("anthropic")` would pass even though the model is correct).

(3) is the most suspicious because the assertion is `includes("anthropic") || includes("claude")` for the claude case and `includes("openai") || includes("gpt") || includes("chatgpt")` for the gpt case. A response like "Not Anthropic. OpenAI." would pass both branches in real life but might be tripping the **negative** path in the test. Actually re-reading the failing output `"got: anthropic"` — the test logs the response text. If the response was "Not Anthropic. OpenAI." we'd see that. The fact it logs only `"anthropic"` (lowercased, trimmed by the harness) suggests the entire response is the word "anthropic" — which is claude lying or the model genuinely being claude.

### How we decide

The user prefers e2e + real LLM over faux mocks for this. The plan: **remove the skip, run the test multiple times under `--project http`, look at the captured response in failures.** Three outcomes:

- Always fails with "anthropic" — code bug. Instrument `rehydrateSession` and the prompt path; the diagnostic will narrow it within an hour.
- Sometimes fails — LLM sensitivity to replayed-history conditioning (possibility 2). Adjust the test (use distinct-enough prompts that the model can't mirror the prior answer, e.g. a different provenance-style question on the second turn that doesn't appear in the first turn's reply).
- Always passes — was a transient at the time we marked the skip; remove and move on.

This is empirical because the static read found no defect. The user signed off on this approach: "will prefer moving the test to e2e and use the real llm if required".

## Plan

### Step 1 — Strengthen the rehydrate seam

Decide on the architectural posture: **per-method `NEEDS_REHYDRATE` set is fragile**; every new agent method that touches in-memory state silently breaks under http. Two cleaner options:

A. **Always rehydrate when params include a sessionId.** Drop the set; rehydrate before any JSON method whose params have a string `sessionId` field (matches today's set + navigate + future methods). Costs one extra SQLite read per request for methods that don't strictly need it (cheap). Eliminates the bug class.

B. **Keep the set but audit it exhaustively** against every agent method that reads `this.sessions.get(sessionId)`. Cheaper at runtime, manual classification required forever.

**Recommendation: (A).** It removes the failure mode entirely. The SQLite read cost is negligible against an HTTP round-trip. The agent's `resumeSession` is idempotent (replays no history). This is the single change that fixes Bug 2 and pre-empts every adjacent rot.

Concrete change in `packages/bodhi-pi-http/src/server/acp/handler.ts` (~line 160-180):

```ts
// Methods that read in-memory SessionState need transparent rehydration from
// store, since each HTTP request gets a fresh agent. Any method whose params
// carry a `sessionId` is treated as session-bound and rehydrated up-front.
const sid = (params as { sessionId?: unknown }).sessionId;
if (typeof sid === "string" && agent.resumeSession) {
  await agent.resumeSession({ sessionId: sid, cwd: wired.cwd, mcpServers: [] } as never);
}
```

Keep the comment block; this replaces the `NEEDS_REHYDRATE` set + its check. The SSE path (`handleSseMethod`) already rehydrates unconditionally for `session/prompt` — no change needed there.

### Step 2 — Remove the two e2e skips

**Critical files:**
- `packages/bodhi-pi/e2e/shared/chat.e2e.ts` — drop `test.runIf(!isRuntime("http"))` from the `"switching model mid-session changes provenance"` test (and the comment above it).
- `packages/bodhi-pi/e2e/shared/tree-navigate.e2e.ts` — same for the `/tree + /goto` test.

### Step 3 — Run + iterate

`cd packages/bodhi-pi && npm run test:e2e -- --project http`. Two outcomes:

- **Both green** — done. Move to Step 4.
- **chat still fails** — apply the empirical loop from "How we decide" above:
  - Capture the failing response text from the harness logs.
  - If it always says "anthropic" → instrument `_buildSessionState` to log `model.id`, and `prompt()` to log `session.runtime.piAgent.state.model.id`. Confirm whether the agent really has gpt loaded. Adjust based on what we find.
  - If it's intermittent or "Not Anthropic, OpenAI" style → adjust the test to use a less-mirror-prone phrasing.

### Step 4 — Validate

1. `cd packages/bodhi-pi && npm run test:e2e` — full 3-project suite. Expect:
   - 41 passed (was 39), 14 skipped (was 16) — only the in-memory-only event/extension tests remain skipped under cli + http.
   - `|http|` label visible on both previously-skipped tests.
2. `npm run check` at monorepo root — typecheck + biome clean.
3. `just test` — monorepo gate green (tolerate the known unrelated flake in bodhi-pi-chrome-ext / bodhi-pi-web playwright, same as Phase 3).

### Step 5 — Commit + retro

One commit:

```
bodhi-pi-http: rehydrate any sessionId-bearing JSON method (drop NEEDS_REHYDRATE set)

bodhi-pi/e2e: enable chat model-switch + tree-navigate under http project
```

Retrospective note for the next session: the per-method `NEEDS_REHYDRATE` set was rot-prone. The "any sessionId triggers rehydrate" rule is the contract bodhi-pi-http should keep going forward. If we ever add stateful HTTP methods that DON'T take a sessionId, revisit.

## Critical files

**Modified:**
- `packages/bodhi-pi-http/src/server/acp/handler.ts` — replace `NEEDS_REHYDRATE` set with unconditional rehydrate when params contain a `sessionId`.
- `packages/bodhi-pi/e2e/shared/chat.e2e.ts` — remove `runIf` and its comment.
- `packages/bodhi-pi/e2e/shared/tree-navigate.e2e.ts` — same.

**Possibly modified** (depending on Step 3 outcome):
- The chat test's prompt phrasing, if Bug 1 turns out to be LLM-conditioning rather than a code bug.
- `packages/bodhi-pi/src/acp/agent.ts` — only if Step 3 surfaces a real rehydrate / model-resolution bug.

**Not modified (intentionally):**
- `packages/bodhi-pi/src/acp/agent.ts`'s `handleSessionNavigate` — the `session && ` guard stays; rehydration in the http handler ensures `session` is populated.

## Reused functions / patterns

- `agent.resumeSession({sessionId, cwd, mcpServers: []})` — `packages/bodhi-pi/src/acp/agent.ts:527`. Already idempotent and history-replay-free; safe to call on every request.
- `wired.cwd` resolution — `packages/bodhi-pi-http/src/server/agent/wire-agent.ts`. The handler already passes this into the existing `NEEDS_REHYDRATE`-gated rehydrate.
- The existing SSE-path rehydrate (`handleSseMethod` ~line 248) — already does the unconditional rehydrate for prompt/load. Step 1 brings the JSON path into alignment.

## Verification

End-to-end: `cd packages/bodhi-pi && npm run test:e2e` shows 41 passed (no `runIf` skips for chat / tree-navigate); both tests visible under `|http|` label. `npm run check` clean. `just test` green modulo known unrelated flake.

## Open question deferred to implementation

Whether Bug 1 turns out to be a code bug or LLM-conditioning is only knowable by running. If it's a code bug, this plan grows a small bodhi-pi agent fix; if it's conditioning, the chat test gets a tighter prompt. Either way the http skip goes away.
