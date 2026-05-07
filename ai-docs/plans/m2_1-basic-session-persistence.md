# Plan — Milestone M2.1: Basic Session Persistence (persist · load · list · close)

## Context

Today bodhi-pi keeps each ACP session's transcript only in the per-session `pi-agent-core` `Agent` instance held in memory by `BodhiPiAcpAgent`. Reconnect or restart and the conversation is gone. M2.1 introduces durable session state behind a host-provided `SessionStore` interface — making "embed bodhi-pi in any host" actually mean something. This is also the milestone that lights up three new ACP methods: `session/load`, `session/list`, `session/close`.

This is bodhi-pi's first interface that hosts must construct and inject. **No fallback** — if `BodhiPiConfig.sessionStore` is absent, factory throws. Same rule applies to all future host-provided interfaces (Filesystem, Terminal, Permissioner, ModelAuth).

We split coding-agent's session machinery into two milestones:
- **M2.1 (this one) — Basic:** persist messages + model-change metadata; load with ACP-spec streaming replay; list with cwd filter; close.
- **M2.2 (later) — Intermediate:** fork, clone, branch, compaction entries, custom entries, label entries, branch summaries, tree navigation.

## Decisions (confirmed)

- **No default fallback for `sessionStore`.** `BodhiPiConfig.sessionStore: SessionStore` is required; factory throws if missing. Pattern repeats for future interfaces.
- **Ship `createInMemorySessionStore()` as a named public helper.** Tests use it; production hosts wanting ephemeral mode can import it. They still must pass it explicitly.
- **Persist model-switch metadata as `ModelChangeEntry`.** On `session/load`, the agent walks entries to find the latest `model_change`, restores that model in the new pi-agent-core `Agent`, then streams the message replay.
- **`session/load` follows ACP spec exactly:** agent emits `user_message_chunk` / `agent_message_chunk` `session/update` notifications for every persisted message during the load request, then responds with an empty `{}`.
- **`session/close` releases ACTIVE resources only, never deletes persisted data.** Per the ACP `session/close` RFD (`docs/rfds/session-close.mdx`): "agent **must** cancel any ongoing work related to the session (treat it as if `session/cancel` was called) and then free up any resources associated with **the active session**." Implementation: cancel any in-flight prompt, drop the live `pi-agent-core` Agent from `BodhiPiAcpAgent.sessions` Map. The store record stays. A subsequent `session/load(sameId)` MUST re-hydrate and stream history back. Subsequent `session/prompt(sameId)` without a prior `session/load` returns a JSON-RPC error (per spec: load before prompting on a closed session).
- **Permanent delete via custom extension method `_bodhi-pi/session/delete`.** ACP has no `session/delete`. Per ACP's extensibility spec (`docs/protocol/extensibility.mdx`): "The protocol reserves any method name starting with an underscore (`_`) for custom extensions." We expose a namespaced extension request that maps to `SessionStore.delete(id)`. Advertised via `_meta` on `agentCapabilities` so capability-aware hosts can detect it (`agentCapabilities._meta = { "bodhi-pi": { sessionDelete: true } }`).
- **No `session/resume`, no `unstable_forkSession`, no `session/setMode`** — out of M2.1.

## ACP scope cut-list

| Method | Direction | M2.1 status | Capability flag |
|---|---|---|---|
| `session/new` | client→agent | already done (M1.x) — extend to also call `sessionStore.create()` | n/a (always supported) |
| `session/prompt` | client→agent | already done — extend to call `sessionStore.appendMessage` on each persisted message | n/a |
| `session/cancel` | client→agent | already done | n/a |
| `session/setSessionConfigOption` | client→agent | already done (M1.3) — extend to call `sessionStore.appendModelChange` when model changes | n/a |
| `session/load` | client→agent | **new in M2.1** | `agentCapabilities.loadSession: true` |
| `session/list` | client→agent | **new in M2.1** | `agentCapabilities.sessionCapabilities.list: {}` |
| `session/close` | client→agent | **new in M2.1** — release active resources only; data persists | `agentCapabilities.sessionCapabilities.close: {}` |
| `_bodhi-pi/session/delete` | client→agent | **new in M2.1** — custom extension; permanently removes from `SessionStore` | advertised via `agentCapabilities._meta.bodhi-pi.sessionDelete: true` |
| `session/update`-`user_message_chunk` | agent→client | **new in M2.1** (during load replay) | n/a |
| `session/update`-`agent_message_chunk` | agent→client | already done — reused for load replay | n/a |
| `session/resume` | client→agent | **deferred to M2.2** | `agentCapabilities.sessionCapabilities.resume` |
| `unstable_forkSession` | client→agent | **deferred to M2.2** | `agentCapabilities.sessionCapabilities.fork` |
| `session/setMode` | client→agent | not planned (config-options is the preferred mechanism) | n/a |
| `session/delete` | — | not in ACP spec; we ship the `_`-prefixed extension above instead | — |

The `initialize` response now advertises three additional capability bits (`loadSession`, `sessionCapabilities.list`, `sessionCapabilities.close`).

## SessionStore interface

A small, host-injectable interface inspired by coding-agent's `SessionManager` (`packages/coding-agent/src/core/session-manager.ts`) but stripped to the basic-only entry types.

```ts
// src/sessions/session-store.ts

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Discriminator-typed entry persisted in the session log. */
export type SessionEntry =
	| { type: "message"; id: string; timestamp: number; message: AgentMessage }
	| { type: "model_change"; id: string; timestamp: number; provider: string; modelId: string };

/** Header-style metadata for a session. */
export interface SessionRecord {
	id: string;
	cwd: string;
	createdAt: number;
	entries: SessionEntry[];
}

/** Lightweight info returned by list. */
export interface SessionInfo {
	sessionId: string;
	cwd: string;
	createdAt: number;
	messageCount: number;
}

/** Pagination cursor for list. */
export interface ListSessionsRequest {
	cwd?: string;
	cursor?: string;
}
export interface ListSessionsResult {
	sessions: SessionInfo[];
	nextCursor?: string;
}

export interface SessionStore {
	/** Create a brand-new session with the given cwd. Returns the assigned id + initial record. */
	create(meta: { cwd: string }): Promise<SessionRecord>;

	/** Load full record by id. Returns undefined if no such session exists (i.e. never created or already deleted). */
	load(sessionId: string): Promise<SessionRecord | undefined>;

	/** Append one entry. Caller (the agent) provides the entry id (uuid). */
	append(sessionId: string, entry: SessionEntry): Promise<void>;

	/** List sessions (optional cwd filter + cursor). */
	list(req: ListSessionsRequest): Promise<ListSessionsResult>;

	/** Permanently delete a session and all its entries. Used by the `_bodhi-pi/session/delete` extension method. */
	delete(sessionId: string): Promise<void>;
}
```

Note there is **no** `close()` on the store. ACP `session/close` is purely a runtime concern (drop the live `pi-agent-core` Agent from the in-process cache, abort any pending prompt) — it does not touch the store. A store implementation should treat sessions as durable until explicitly `delete`d.

Decisions baked into the shape:
- **Caller provides entry ids** (uses `crypto.randomUUID()` in agent code). Keeps the store dumb.
- **Two entry types only** (`message`, `model_change`). Compaction/fork/branch/label/custom variants land in M2.2 by widening the union.
- **Cursor is a string** the store opaque-defines. In-memory impl just returns no cursor (single page). Real disk-backed impls (M2.2+) can use it.
- **No `update` method.** Append-only. Aligns with coding-agent's JSONL design.
- **No `getCwd()` etc.** — `SessionRecord.cwd` is the single source of truth.

## In-memory implementation

```ts
// src/sessions/in-memory-session-store.ts

import { randomUUID } from "node:crypto";
import type { ListSessionsRequest, ListSessionsResult, SessionEntry, SessionRecord, SessionStore } from "./session-store.js";

export function createInMemorySessionStore(): SessionStore {
	const sessions = new Map<string, SessionRecord>();

	return {
		async create({ cwd }) {
			const record: SessionRecord = {
				id: randomUUID(),
				cwd,
				createdAt: Date.now(),
				entries: [],
			};
			sessions.set(record.id, record);
			return structuredClone(record);
		},
		async load(sessionId) {
			const record = sessions.get(sessionId);
			return record ? structuredClone(record) : undefined;
		},
		async append(sessionId, entry: SessionEntry) {
			const record = sessions.get(sessionId);
			if (!record) throw new Error(`session ${sessionId} not found (or closed)`);
			record.entries.push(entry);
		},
		async list({ cwd, cursor }) {
			const all = [...sessions.values()]
				.filter((r) => (cwd ? r.cwd === cwd : true))
				.sort((a, b) => b.createdAt - a.createdAt)
				.map((r) => ({
					sessionId: r.id,
					cwd: r.cwd,
					createdAt: r.createdAt,
					messageCount: r.entries.filter((e) => e.type === "message").length,
				}));
			// Single-page in-memory; cursor is not used.
			void cursor;
			return { sessions: all };
		},
		async delete(sessionId) {
			sessions.delete(sessionId);
		},
	};
}
```

`structuredClone` (Node 18+) keeps callers from mutating the store's internals.

## Architecture delta

```
BodhiPiConfig {
    models: Model<Api>[]
    defaultModelId: string
    getApiKey: (provider) => string | undefined
+   sessionStore: SessionStore        // mandatory; no default
}

BodhiPiAcpAgent {
    sessions = new Map<sessionId, {
        piAgent: PiAgent,
        currentModelId: string,
+       cwd: string,                  // captured from session/new request
    }>()

    initialize    // returns extended capabilities (loadSession, sessionCapabilities.list/close)
                  // + _meta.bodhi-pi.sessionDelete: true
    newSession    // also calls sessionStore.create()
+   loadSession   // reads store, restores model + messages, replays via session/update
+   listSessions  // delegates to sessionStore.list
+   closeSession  // cancels pending + drops from in-memory cache (data persists in store)
+   extMethod     // dispatches "_bodhi-pi/session/delete" → sessionStore.delete + drop cache
    setSessionConfigOption  // also persists ModelChangeEntry
    prompt        // also persists each message_end → SessionMessageEntry
                  // refuses if sessionId not in cache (forces explicit load after close)
    cancel
}
```

## Files

### New

- `packages/bodhi-pi/src/sessions/session-store.ts` — interface + entry types.
- `packages/bodhi-pi/src/sessions/in-memory-session-store.ts` — `createInMemorySessionStore()` helper.

### Modified

- `packages/bodhi-pi/src/index.ts` — export `SessionStore`, entry types, `createInMemorySessionStore`.
- `packages/bodhi-pi/src/acp/agent.ts` — add mandatory `sessionStore` to `BodhiPiConfig`; implement `loadSession`, `listSessions`, `closeSession`; advertise new capabilities; persist on append events.
- `packages/bodhi-pi/test/chat.test.ts` — extend with persist + load + list + close integration tests using `createInMemorySessionStore()`.
- `packages/bodhi-pi/e2e/chat.e2e.ts` — add one multi-turn context-retention e2e (real LLM remembers fact across two prompts in same session).
- `packages/bodhi-pi/CHANGELOG.md` — M2.1 entry.

### Untouched

- `packages/bodhi-pi/test/helpers/in-process-connection.ts`, `vitest.config.ts`, `vitest.e2e.config.ts`, `tsconfig.build.json`, env files, root tsconfig + biome configs.

## `src/acp/agent.ts` changes (sketches of new + changed methods)

`BodhiPiConfig` and factory check:

```ts
import type { SessionStore, SessionEntry } from "../sessions/session-store.js";

export interface BodhiPiConfig {
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	sessionStore: SessionStore;   // mandatory
}

export function createBodhiPiAgent(config: BodhiPiConfig) {
	if (!config.sessionStore) {
		throw new Error("BodhiPiConfig.sessionStore is required (no default fallback)");
	}
	if (!config.models.find((m) => m.id === config.defaultModelId)) {
		throw new Error(`defaultModelId "${config.defaultModelId}" not in models registry`);
	}
	return (conn: AgentSideConnection): AcpAgent => new BodhiPiAcpAgent(config, conn);
}
```

`initialize` advertises new capabilities:

```ts
async initialize(_params): Promise<InitializeResponse> {
	return {
		protocolVersion: 1,
		agentCapabilities: {
			loadSession: true,                                   // NEW
			sessionCapabilities: { list: {}, close: {} },        // NEW
			promptCapabilities: { image: false, audio: false, embeddedContext: false },
			mcpCapabilities: { http: false, sse: false },
			_meta: {
				"bodhi-pi": { sessionDelete: true },             // NEW: advertise extension
			},
		},
		authMethods: [],
	};
}
```

`newSession` also creates the store record:

```ts
async newSession(params): Promise<NewSessionResponse> {
	const record = await this.config.sessionStore.create({ cwd: params.cwd });
	const defaultModel = this.findModel(this.config.defaultModelId);
	const piAgent = createAgentSession({
		initialState: { model: defaultModel },
		getApiKey: this.config.getApiKey,
	});
	this.sessions.set(record.id, { piAgent, currentModelId: this.config.defaultModelId, cwd: record.cwd });
	return {
		sessionId: record.id,
		configOptions: [this.buildModelConfigOption(this.config.defaultModelId)],
	};
}
```

`prompt` persists each `message_end`:

```ts
const unsubscribePersist = session.piAgent.subscribe(async (event) => {
	if (event.type !== "message_end") return;
	if (event.message.role !== "user" && event.message.role !== "assistant" && event.message.role !== "toolResult") return;
	await this.config.sessionStore.append(params.sessionId, {
		type: "message",
		id: randomUUID(),
		timestamp: Date.now(),
		message: event.message,
	});
});
// (existing text_delta → agent_message_chunk subscription stays separate)
```

`setSessionConfigOption` also persists model changes:

```ts
session.piAgent.state.model = newModel;
session.currentModelId = params.value;
await this.config.sessionStore.append(params.sessionId, {
	type: "model_change",
	id: randomUUID(),
	timestamp: Date.now(),
	provider: newModel.provider,
	modelId: newModel.id,
});
```

`loadSession` (NEW) — full ACP-spec replay:

```ts
async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
	const record = await this.config.sessionStore.load(params.sessionId);
	if (!record) throw new RequestError(-32602, `unknown session: ${params.sessionId}`);

	// Determine restored model: latest model_change entry, else config default.
	const lastModelChange = [...record.entries].reverse().find((e) => e.type === "model_change");
	const modelId = lastModelChange?.modelId ?? this.config.defaultModelId;
	const restoredModel = this.findModel(modelId);

	// Recreate pi-agent with restored messages.
	const messages = record.entries
		.filter((e) => e.type === "message")
		.map((e) => e.message);
	const piAgent = createAgentSession({
		initialState: { model: restoredModel, messages },
		getApiKey: this.config.getApiKey,
	});
	this.sessions.set(record.id, { piAgent, currentModelId: modelId, cwd: record.cwd });

	// Stream history back via session/update notifications, in order.
	for (const entry of record.entries) {
		if (entry.type !== "message") continue;
		const role = entry.message.role;
		if (role === "user") {
			await this.conn.sessionUpdate({
				sessionId: params.sessionId,
				update: { sessionUpdate: "user_message_chunk", content: extractTextContent(entry.message) },
			});
		} else if (role === "assistant") {
			await this.conn.sessionUpdate({
				sessionId: params.sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: extractTextContent(entry.message) },
			});
		}
		// toolResult / tool_call replays land in M3.x when tools exist.
	}

	return {};
}
```

`listSessions` (NEW):

```ts
async listSessions(params): Promise<ListSessionsResponse> {
	const result = await this.config.sessionStore.list({ cwd: params.cwd, cursor: params.cursor });
	return {
		sessions: result.sessions.map((s) => ({
			sessionId: s.sessionId,
			cwd: s.cwd,
			// title/lastUpdate fields are optional in ACP shape — leave for M2.2 metadata work.
		})),
		nextCursor: result.nextCursor,
	};
}
```

`closeSession` (NEW) — release active resources only; do NOT touch the store:

```ts
async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
	const cached = this.sessions.get(params.sessionId);
	cached?.piAgent.abort();           // treat as session/cancel per ACP RFD
	this.sessions.delete(params.sessionId);   // drop in-memory live agent
	// SessionStore is NOT touched — record persists for future session/load.
	return {};
}
```

`extMethod` (NEW) — dispatcher for the custom `_bodhi-pi/session/delete` extension:

```ts
async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	if (method === "_bodhi-pi/session/delete") {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, "_bodhi-pi/session/delete: sessionId must be a string");
		}
		// Cancel + drop active agent if cached, then permanently delete from store.
		this.sessions.get(sessionId)?.piAgent.abort();
		this.sessions.delete(sessionId);
		await this.config.sessionStore.delete(sessionId);
		return {};
	}
	throw new RequestError(-32601, `Method not found: ${method}`);
}
```

`prompt` precondition — refuses prompts on sessions that aren't loaded in cache (i.e. closed-and-not-reloaded):

```ts
async prompt(params: PromptRequest): Promise<PromptResponse> {
	const session = this.sessions.get(params.sessionId);
	if (!session) {
		throw new RequestError(
			-32602,
			`session ${params.sessionId} is not loaded. Call session/load first.`,
		);
	}
	// ... rest unchanged
}
```

References to existing surfaces being reused:
- `pi-agent-core` `Agent`'s `initialState.messages` accepts a pre-populated transcript (`packages/agent/src/agent.ts:67-91`) — this is how we rehydrate.
- `pi-agent-core` event `message_end` (`packages/agent/src/types.ts:374`) is emitted after each user / assistant / toolResult message is finalized — perfect persistence trigger.
- coding-agent's persist-on-`message_end` pattern (`packages/coding-agent/src/core/agent-session.ts:530-547`) — we mirror this directly.
- coding-agent's `SessionManager.create / inMemory` factory shape (`packages/coding-agent/src/core/session-manager.ts:1269-1307`) — informs our `SessionStore` interface.
- ACP TS SDK `Agent` interface methods (`/tmp/acp-sdk-inspect/package/dist/acp.d.ts`):
  - `loadSession?` (line ~870), `listSessions?` (line ~890), `closeSession?` (line ~910).
- ACP `LoadSessionRequest`, `ListSessionsRequest/Response`, `CloseSessionRequest/Response`, `SessionListCapabilities`, `SessionCloseCapabilities` (verify in `types.gen.d.ts` during implementation; explore showed them at lines ~2117, ~2033, ~728, ~4192, ~3929).
- ACP `SessionUpdate` variants `user_message_chunk` and `agent_message_chunk` (`schema/types.gen.d.ts:4331+`).

## Test plan

### Integration (`test/chat.test.ts`) — three new tests added to existing file

**Helper (top of file):** instantiate a fresh in-memory store per test:

```ts
function makeStore() { return createInMemorySessionStore(); }
```

Existing two M1.3 tests get a one-line edit to pass `sessionStore: makeStore()` in the `BodhiPiConfig`.

**New test 1 — "persists messages and restores via session/load":**
- One LLMock; aimock fixture: any prompt → "noted".
- Create session, send one prompt, capture sessionId.
- Verify in-store: `await store.load(sessionId)` returns 2 message entries (user + assistant).
- Open a second `clientConn` against the **same factory** (both share the same store instance), call `clientConn2.loadSession({ sessionId, cwd, mcpServers: [] })`.
- Collect `session/update` notifications during the load; assert one `user_message_chunk` then one `agent_message_chunk` in order, both containing the right text.

**New test 2 — "lists sessions filtered by cwd":**
- Create three sessions: two with `cwd: /a`, one with `cwd: /b`.
- `clientConn.listSessions({ cwd: "/a" })` → assert exactly 2 entries, sorted by createdAt desc, `messageCount: 0`.
- `clientConn.listSessions({})` → assert all 3.

**New test 3 — "close releases active resources but data persists":**
- Create + prompt a session.
- Call `clientConn.closeSession({ sessionId })`.
- Subsequent `prompt` on that sessionId → expect a JSON-RPC error (`session ... not loaded`).
- `await store.load(sessionId)` → **still returns the full record** (data persisted).
- `clientConn.listSessions({})` → **still includes** the session.
- `clientConn.loadSession({ sessionId, cwd, mcpServers: [] })` → succeeds, replays history.
- After load, `prompt` on that sessionId works again.

**New test 5 — "permanent delete via _bodhi-pi/session/delete":**
- Create + prompt a session.
- Call `clientConn.extMethod("_bodhi-pi/session/delete", { sessionId })`.
- `await store.load(sessionId)` → returns `undefined`.
- `clientConn.listSessions({})` → does not include the deleted session.
- `clientConn.loadSession({ sessionId, ... })` → expect JSON-RPC error (unknown session).
- Verify `initialize` response advertises `agentCapabilities._meta.bodhi-pi.sessionDelete === true` so capability-aware hosts can detect the extension.

**New test 4 — "model change persists across load":**
- Two LLMock instances (mockA returns "from-a", mockB returns "from-b").
- Create session, prompt → "from-a".
- Switch model via `setSessionConfigOption` to model-b.
- Prompt → "from-b".
- Load session in fresh client; the restored pi-agent should have model-b active.
- Prompt once more → "from-b" again (proving model-change entry was respected on load).

### E2E (`e2e/chat.e2e.ts`) — one new test added

**"context retention across two prompts via real LLM":**
- Real Anthropic Haiku, in-memory store.
- One session.
- Prompt 1: `"My favourite number is 42. Reply with the single word 'noted'."` → assert response contains `"noted"` (case-insensitive).
- Prompt 2: `"What is my favourite number? Reply with just the digits."` → assert response contains `"42"`.
- Asserts pi-agent context survives because we kept the same `Agent` instance — but the *purpose* of this test in M2.1 is to verify the message-persistence subscription doesn't *break* multi-turn behaviour.

Existing 3 e2e tests get the one-line `sessionStore: createInMemorySessionStore()` edit.

## CHANGELOG entry

```
## [Unreleased]

### Added
- M2.1 — Basic session persistence over ACP. New mandatory
  `BodhiPiConfig.sessionStore: SessionStore` (no default fallback). Ships
  `createInMemorySessionStore()` as a public helper. Agent now advertises
  `loadSession`, `sessionCapabilities.list`, `sessionCapabilities.close`
  capabilities and implements `session/load` (with full ACP-spec history
  replay via `user_message_chunk` / `agent_message_chunk` notifications),
  `session/list` (with cwd filter), and `session/close` (cancels +
  releases). Each prompt's `message_end` events persist as
  `SessionMessageEntry`; `setSessionConfigOption(model)` also persists a
  `ModelChangeEntry`. On `session/load` the agent restores the latest
  model from history before replaying messages.
```

## Implementation steps (TDD-ish)

1. Create `src/sessions/session-store.ts` with the interface + entry types.
2. Create `src/sessions/in-memory-session-store.ts` with `createInMemorySessionStore()`.
3. Update `src/index.ts` exports.
4. Update `src/acp/agent.ts`:
   - Add `sessionStore` to `BodhiPiConfig` + mandatory check.
   - Extend `initialize` capabilities.
   - Persist messages in `prompt` via `message_end` subscription.
   - Persist model change in `setSessionConfigOption`.
   - Implement `loadSession`, `listSessions`, `closeSession`.
   - Capture `cwd` per session.
5. Update existing tests in `test/chat.test.ts` and `e2e/chat.e2e.ts` to pass `sessionStore`.
6. Add new integration tests (5 new in `chat.test.ts` — persist+load, list+filter, close-keeps-data, model-persists, ext-delete).
7. Add new e2e test (1 new in `chat.e2e.ts`).
8. Update `CHANGELOG.md`.
9. Gate-checks (see Verification).
10. Commit: `feat(bodhi-pi): land M2.1 — basic session persistence (load · list · close)`.

## Verification

```bash
# Lint + typecheck across the monorepo
npm run check

# Build
npm --workspace @bodhiapp/bodhi-pi run build

# Offline (unit + integration via aimock + ACP)
npm --workspace @bodhiapp/bodhi-pi run test

# Online (real LLMs via ACP)
npm --workspace @bodhiapp/bodhi-pi run test:e2e
```

Expected:
- `npm run check` — clean.
- `build` — emits `dist/{index,core/agent-session,acp/agent,sessions/session-store,sessions/in-memory-session-store}.{js,d.ts}` plus maps.
- `test` — 7 integration tests pass (2 from M1.3 baseline + 5 new in M2.1).
- `test:e2e` — 4 e2e tests pass (3 from M1.3 baseline + 1 new context-retention).

Acceptance gate: an ACP-aware host can drive bodhi-pi through `initialize → newSession → prompt → close → list → load(sameId)` and observe the full message history streamed back via `session/update` notifications.

## Out of scope for M2.1 (and where each lands)

| Concern | Lands in |
|---|---|
| `session/resume` (no-replay variant) | M2.2 |
| `unstable_forkSession` / clone | M2.2 |
| Branch summaries, label entries, custom entries | M2.2 |
| Compaction entries | Phase 6 |
| Disk-backed `SessionStore` (JSONL on disk) | M2.x — separate impl, same interface |
| Tool-call replay in `loadSession` | M3.x (when tools exist) |
| Image / multimodal content replay | v1.1 |
| `session_info_update` notification on title generation | future polish |
| Session name / display title metadata | M2.2 (with `appendSessionInfo`-style entry) |
| Pagination cursor in `listSessions` | M2.2 (when first disk-backed store needs it) |
| `additionalDirectories` in load/new | not implementing; unstable in spec |

## Critical files referenced

- `packages/coding-agent/src/core/session-manager.ts:1269-1307` — `SessionManager` factory shape; informs our `SessionStore`.
- `packages/coding-agent/src/core/session-manager.ts:30-65` — entry types we mirror (header/message/model_change subset).
- `packages/coding-agent/src/core/agent-session.ts:530-547` — pattern: subscribe to `pi-agent-core` `message_end` and append to session manager.
- `packages/agent/src/agent.ts:67-91` — `initialState.messages` rehydration path used by `loadSession`.
- `packages/agent/src/types.ts:374` — `AgentEvent` `message_end` variant.
- `/tmp/acp-sdk-inspect/package/dist/acp.d.ts` — TS SDK Agent interface (`loadSession?`, `listSessions?`, `closeSession?` optional methods).
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts` — exact `LoadSessionRequest/Response`, `ListSessionsRequest/Response`, `CloseSessionRequest/Response`, `SessionListCapabilities`, `SessionCloseCapabilities`, `SessionUpdate` variants.
- `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/docs/protocol/session-setup.mdx` — normative replay-via-notifications behaviour for `session/load`.
- `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/docs/protocol/session-list.mdx` — pagination semantics.

## After approval

After M2.1 lands, save these durable preferences to memory (project-feedback type):
- bodhi-pi's host-injected interfaces are **mandatory with no default fallback**. Factory throws if absent. The pattern: ship a reference helper (e.g. `createInMemorySessionStore`) but never fall back silently.
- **ACP `session/close` releases active runtime resources only — it never deletes persisted data.** Per the ACP `session/close` RFD: cancel-as-if-cancel + free in-process state. The persisted record stays loadable. `SessionStore` therefore has no `close()` method.
- **Permanent delete is a bodhi-pi extension (`_bodhi-pi/session/delete`)**, not an ACP-spec method. Underscore-prefixed names are reserved for extensions per ACP's `extensibility.mdx`. Advertise via `agentCapabilities._meta.bodhi-pi`.
- `SessionStore` is append-only for entries; only `delete()` removes a session terminally.
- Persistence happens via `pi-agent-core` event subscription (`message_end`), mirroring coding-agent. Tools/compaction will plug into the same subscription site as new event types arrive.
- ACP `session/load` always streams history via `session/update` notifications — never short-circuit to "return transcript in response", even when convenient.
