# bodhi-pi MCP: session-persisted inclusion + host-owned connections

## Context

Two interlocking changes:

1. **MCP inclusion becomes session state**. `mcpInclude`/`mcpExclude` write a `mcp_inclusion_set` snapshot entry (like `model_change`). `session/load` and `session/resume` restore the previously-included slugs automatically. No more "include is lost across rebuild".

2. **MCP connections become host responsibility**. The SDK stops owning the `bySlug` connection map. A new `McpConnectionProvider` interface is host-injected; the SDK delegates connect/disconnect/reconnect/tools-read to it. Different hosts use different lifetimes:
   - cli, in-memory: in-process provider, single user.
   - test-app-http, test-app-ws-server: per-user `Map<userId, ...>` at server-process scope. Survives per-request agent rebuild.
   - test-app-browser, test-app-chrome-ext: worker-scoped provider mirrored to `localStorage` / `chrome.storage` so page-refresh / extension-reload can restore.

With both, the previously-gated http MCP tests pass, and the four Playwright runtimes converge on the same behavior.

---

## Phasing (depth-first, one commit per slice)

Established convention: don't touch all hosts at once. SDK lands first as **backwards-compatible** (default provider matches today's behavior), then each runtime migrates as its own slice, gated by that runtime's vitest e2e + e2e-ui green-light. Order goes simple-first.

| Slice | What lands | Done when |
|---|---|---|
| 0 | SDK foundation | `bodhi-pi/test/*` (404) + `bodhi-pi-cli/test/*` (22) all pass. in-memory vitest e2e MCP suite green. |
| 1 | in-memory polish + session-resume contract test | `e2e/shared/mcp-session-resume.e2e.ts` passes on `in-memory` project. |
| 2 | cli runtime + cli-headless | cli vitest e2e MCP suite + cli-headless MCP e2e green. |
| 3 | http (ServerMcpStore for test-app-http JSON+SSE) | http vitest e2e MCP un-gated and passing; e2e-ui `mcp-public-http.spec.ts` + `mcp-multi.spec.ts` passing under `[http]`. |
| 4 | ws (ServerMcpStore for test-app-http WS) | ws vitest e2e MCP suite passing; e2e-ui passing under `[ws]`. |
| 5 | browser (localStorage-backed provider + worker boot restore) | e2e-ui passing under `[browser]` including an explicit `page.reload()` step in the spec. |
| 6 | chrome-ext (chrome.storage-backed provider) | e2e-ui passing under `[chrome-ext]`. |
| 7 | Cleanup (deepwiki hardcode, TECHDEBT.md, remove `resetMcpConnectStatus`) | No env-var fall-through, no dead-code paths. |

Each slice is one commit. The next slice doesn't start until the previous slice's gate is green.

---

## Slice 0 — SDK foundation (backwards-compatible)

The single change all other slices depend on. Must NOT break any existing host; every host that omits the new config field keeps working with current semantics via the SDK's default provider.

### New files
- `packages/bodhi-pi/src/mcp/mcp-connection-provider.ts` — `McpConnectionProvider` interface (below).
- `packages/bodhi-pi/src/mcp/in-process-provider.ts` — `createInProcessMcpConnectionProvider()` factory, owns a local `Map<slug, ConnectedClient>` and calls `connectMcp` from `mcp-client.ts`. Logic lifted from today's `McpService.connectGlobal` + `McpRegistry.bySlug`.

### `McpConnectionProvider` interface

```ts
export interface McpConnectResult { toolNames: string[]; }

export interface McpConnectionProvider {
  // Lifecycle — SDK auto-wires these as _bodhi-pi/mcp/{connect,disconnect,reconnect}
  connect(slug: string, entry: McpServerEntry): Promise<McpConnectResult>;
  disconnect(slug: string): Promise<void>;
  reconnect(slug: string, entry: McpServerEntry): Promise<McpConnectResult>;

  // Reads
  getTools(slug: string): AgentTool[] | undefined;
  getToolNames(slug: string): string[] | undefined;
  isConnected(slug: string): boolean;
  listConnectedSlugs(): string[];

  // Change subscription (SDK refreshes piAgent.state.tools on fire)
  onChange(handler: () => void): () => void;
}
```

### Changes to existing SDK files

**`src/acp/agent.ts`** — `BodhiPiConfig` (line 65) grows:
```ts
/** Host-injected MCP connection provider. When omitted, SDK installs a
 *  process-local default — appropriate for single-tenant embedded hosts
 *  (cli, in-memory). Multi-tenant hosts (http, ws-server) inject one
 *  bound to a server-level per-user store. */
mcpConnectionProvider?: McpConnectionProvider;
```
In the `createBodhiPiAgent` factory, if undefined, instantiate the default: `config.mcpConnectionProvider ?? createInProcessMcpConnectionProvider()`. Pass to `McpService` deps. Pass restored `mcpSlugs` (from session bootstrap, below) into `mcpService.hydrate(sessionId, params.mcpServers, restored.mcpSlugs)` at L332/L414/L431.

**`src/mcp/mcp-service.ts`** — refactor:
- Inject `provider: McpConnectionProvider` and `appendEntry: AppendEntry` (same shape as `ModelRegistry`'s appendEntry — see `src/models/registry.ts:27,39`).
- Delete `connectGlobal`, `handleTransportClose`, `resetMcpConnectStatus`.
- `handleConnect/Disconnect/Reconnect` → delegate to provider, then emit `mcp_status_change`/`mcp_tools_change` events and persist kv `lastKnownStatus` for `/mcp/list` display.
- `handleTools(sessionId, slug)` → require inclusion + `provider.isConnected(slug)`, return `provider.getToolNames(slug)`.
- `handleList` → cross-reference `provider.isConnected` for live status.
- `handleInclude/Exclude` → after registry mutation, append `mcp_inclusion_set` snapshot entry (full slug list).
- `hydrate(sessionId, ephemeral, restoredSlugs)` — new precedence:
  - `ephemeral === undefined` → inclusion = `restoredSlugs` (session-stored wins). No new entry written.
  - `ephemeral === []` → inclusion = ∅. Write new snapshot entry (overrides session-stored).
  - `ephemeral === [...]` → for each slug in kv, call `provider.connect` if not connected, include. Write new snapshot entry.
- Constructor subscribes: `provider.onChange(() => this.registry.applyToAllSessions())`. Replaces today's explicit per-session event emission for global mutations.

**`src/mcp/mcp-registry.ts`** — slim down:
- Remove `bySlug`, `addConnection`, `removeConnection`, `hasConnection`, `getConnection`, `listConnectedSlugs`, `getToolInfos`.
- Keep `inclusion` map, `addInclusion`, `removeInclusion`, `setInclusion`, `getInclusion`, `clearInclusion`.
- `getVisibleTools(sessionId)` — for each included slug, `provider.getTools(slug)` and concat (returns `[]` for slugs the provider doesn't have connected).
- `applyToSession`, `applyToAllSessions` unchanged in shape; just read tools from provider.
- Constructor takes `provider: McpConnectionProvider` alongside `sessions`.

**`src/sessions/entries.ts`** — add to the `SessionEntry` union:
```ts
export interface McpInclusionEntry extends BaseEntry {
  type: "mcp_inclusion_set";
  slugs: string[];
}
```

**`src/sessions/build-context.ts`** — at the path walk (currently extracts `currentModelId` around L92–95), also extract `mcpSlugs: string[]` by taking the LAST `mcp_inclusion_set` entry's `slugs`. Return both in `SessionContext`.

**`src/sessions/session-bootstrap.ts`** — `rehydrateSession`'s return includes `mcpSlugs: string[]`.

**`src/index.ts`** — export `McpConnectionProvider`, `createInProcessMcpConnectionProvider`, `McpConnectResult`.

### Tests for slice 0
- `packages/bodhi-pi/test/mcp.test.ts` — add tests:
  - mcpInclude writes a `mcp_inclusion_set` entry with the full current slug set.
  - mcpExclude writes a new snapshot entry (without the excluded slug).
  - Session resume with `mcpServers: undefined` restores inclusion from the last `mcp_inclusion_set` entry.
  - Session resume with `mcpServers: []` overrides (empty inclusion + new snapshot entry).
- All existing 404 + 22 unit/integration tests still pass without modification (default provider matches old behavior for in-memory).

**Slice 0 gate**: `cd packages/bodhi-pi && npx vitest run` green; `npx vitest --run --config vitest.e2e.config.ts --project=in-memory e2e/shared/mcp-*.e2e.ts e2e/shared/mcp-multi.e2e.ts` green.

---

## Slice 1 — in-memory session-resume contract test

Adds the cross-runtime contract test that proves the session-persistence end-to-end. Runs first under `in-memory` only; subsequent slices add the other projects to its coverage.

### New test
`packages/bodhi-pi/e2e/shared/mcp-session-resume.e2e.ts`:
1. `mcpAdd → mcpConnect → mcpInclude → mcpTools` — assert tools visible.
2. `clientConn.closeSession({ sessionId })` — drops the in-memory inclusion.
3. `clientConn.resumeSession({ sessionId, cwd, mcpServers: undefined })` — should restore inclusion from the persisted `mcp_inclusion_set` entry.
4. `mcpTools({ slug, sessionId })` — assert same tools as step 1.

Under `in-memory`, the default in-process provider lives with the test harness's single agent, so the connection survives the close-resume cycle in step 2-3 (`closeSession` doesn't disconnect MCPs in the SDK's contract per TECHDEBT.md — already true).

**Slice 1 gate**: `npx vitest --run --config vitest.e2e.config.ts --project=in-memory e2e/shared/mcp-session-resume.e2e.ts` green.

---

## Slice 2 — cli runtime

cli (and test-app-cli) already long-lived single-user. Default SDK provider works as-is. The work here is verifying + filling test coverage.

### Changes
- No code change in `bodhi-pi-cli` or `test-apps/cli` (they use default provider transparently).
- `packages/bodhi-pi-cli/test/*` — confirm green; add a regression test asserting `/mcp include` writes the entry by reading the session store.
- `e2e/cli-headless/mcp-session-resume.e2e.ts` (new) — mirror the in-memory test through stdin/stdout headless flow.

**Slice 2 gate**:
- `cd packages/bodhi-pi-cli && npx vitest run` green.
- `npx vitest --run --config vitest.e2e.config.ts --project=cli e2e/shared/mcp-*.e2e.ts e2e/shared/mcp-multi.e2e.ts e2e/shared/mcp-session-resume.e2e.ts e2e/cli-headless/mcp*.e2e.ts` green.

---

## Slice 3 — http (the load-bearing change)

Per-request agent rebuild needs a server-process-scoped per-user connection cache.

### New file
`packages/bodhi-pi/test-apps/http/src/server/mcp/server-mcp-store.ts`:
```ts
class ServerMcpStore {
  private byUser = new Map<string, McpConnectionProvider>();
  getProviderForUser(userId: string): McpConnectionProvider {
    let p = this.byUser.get(userId);
    if (!p) { p = createInProcessMcpConnectionProvider(); this.byUser.set(userId, p); }
    return p;
  }
}
```
Single instance constructed at server bootstrap in `test-apps/http/src/server/server.ts`. Never evicts (test-app lifecycle is short).

### Wire-up
- `test-apps/http/src/server/agent/wire-agent.ts:125` — pull `mcpConnectionProvider: serverMcpStore.getProviderForUser(opts.user.id)` into the `createBodhiPiAgent` config.
- (ws integration deferred to slice 4.)

### Tests in this slice — http only
- **Un-gate** in `packages/bodhi-pi/e2e/shared/mcp-public-http.e2e.ts`: remove `test.runIf(crossRequestRunIf)` on the 3 currently-gated tests. They should now pass on http via the server-level connection store.
- **Un-gate** in `packages/bodhi-pi/e2e/shared/mcp-multi.e2e.ts`: remove `test.runIf(sessionScopedRunIf)` on the 2 gated control-plane tests + the LLM-uses-2-MCPs test.
- Add `e2e/shared/mcp-session-resume.e2e.ts` to the http project's run (already there via shared/).
- Update `packages/bodhi-pi/e2e-ui/shared/mcp-public-http.spec.ts` — add a step at the end of the slash-cycle test that uses `/sessions` and resumes via the UI, asserting inclusion is restored. Gate this NEW step to runtimes that have closeSession in the UI ([http] now via the server store).
- Update `e2e-ui/shared/mcp-multi.spec.ts` — replace the env-var deepwiki lookup with a hardcoded constant `const DEEPWIKI_URL = "https://mcp.deepwiki.com/mcp"`. Remove the `process.env...=` line from `e2e-ui/global-setup.ts`.
- Other Playwright runtimes ([ws], [browser], [chrome-ext]) in `mcp-public-http.spec.ts` may temporarily skip the new resume-step assertion if their host wiring isn't done yet — slice 4–6 unlock each.

**Slice 3 gate**:
- `npx vitest --run --config vitest.e2e.config.ts --project=http e2e/shared/mcp-*.e2e.ts e2e/shared/mcp-multi.e2e.ts e2e/shared/mcp-session-resume.e2e.ts` green with **ZERO `runIf` skips for http**.
- `cd packages/bodhi-pi/e2e-ui && npx playwright test --project=http mcp-public-http.spec.ts mcp-multi.spec.ts` green.

---

## Slice 4 — ws runtime

Same `ServerMcpStore` as http. Different wire-agent path.

### Wire-up
- `test-apps/http/src/server/agent/wire-agent-ws.ts:109` — pull `mcpConnectionProvider: serverMcpStore.getProviderForUser(opts.user.id)` into the `createBodhiPiAgent` config. Uses the SAME `ServerMcpStore` instance as http (declared at server bootstrap).
- This means a user with both an http session and a ws session shares one connection cache. Acceptable for test-app.

### Tests in this slice — ws only
- `npx vitest --run --config vitest.e2e.config.ts --project=ws e2e/shared/mcp-*.e2e.ts e2e/shared/mcp-multi.e2e.ts e2e/shared/mcp-session-resume.e2e.ts` green.
- `cd packages/bodhi-pi/e2e-ui && npx playwright test --project=ws mcp-public-http.spec.ts mcp-multi.spec.ts` green, including the session-resume UI step.

**Slice 4 gate**: ws vitest e2e + ws e2e-ui green; previous slices remain green.

---

## Slice 5 — browser

Worker-scoped provider with `localStorage` mirror for refresh resilience.

### Wire-up
- New `test-apps/browser/src/ui-lib/runtime/storage-backed-provider.ts` — wraps `createInProcessMcpConnectionProvider()`:
  - On every `connect`/`disconnect`/`reconnect` success, mirror the current `listConnectedSlugs()` to `localStorage.setItem("bodhi-pi-mcp-active-slugs", JSON.stringify([...]))`. The page (main thread) writes to localStorage; worker posts a message to the page on changes (use existing worker↔page bridge).
  - At worker boot, the page reads localStorage and posts the slug list to the worker. Worker iterates: for each slug, look up kv (`mcp/<slug>`), call `provider.connect`. Best-effort; failures are logged but don't block.
- `test-apps/browser/src/ui-lib/runtime/bootstrap-worker.ts:173` — pass `mcpConnectionProvider: storageBackedProvider` into the `createBodhiPiAgent` config.

### Tests in this slice — browser only
- e2e-ui `[browser]` runs `mcp-public-http.spec.ts` + `mcp-multi.spec.ts` and a new step: explicit `await page.reload()` after `/mcp connect + /mcp include`, then assert tools still visible. Gate this `page.reload` step to the `[browser]` project (or any with persistence policy).

**Slice 5 gate**: `npx playwright test --project=browser mcp-public-http.spec.ts mcp-multi.spec.ts` green including the page-reload step; other projects unchanged.

---

## Slice 6 — chrome-ext

Same shape as browser, using `chrome.storage.local` (or `chrome.storage.session` if available) instead of localStorage. Service-worker boot reads the list and reconnects.

### Wire-up
- `test-apps/chrome-ext/src/...` — clone the storage-backed provider, adapt the storage API.
- Service-worker boot hook reads `chrome.storage.local.get("bodhi-pi-mcp-active-slugs")`, posts to the worker.

### Tests in this slice — chrome-ext only
- e2e-ui `[chrome-ext]` runs `mcp-public-http.spec.ts` + `mcp-multi.spec.ts` green.
- Optional: extension-reload restore test (Playwright reloads the extension; provider rebuilds; tools restored). Stretch — file in TECHDEBT.md if not done.

**Slice 6 gate**: `npx playwright test --project=chrome-ext mcp-public-http.spec.ts mcp-multi.spec.ts` green.

---

## Slice 7 — cleanup

Final-pass housekeeping.

- Delete `resetMcpConnectStatus` plumbing entirely — it landed in an earlier change as a workaround; with the new model it's obsolete.
- Update `packages/bodhi-pi/TECHDEBT.md`:
  - **Replace** the "ephemeral state stored in persistent kv" section with: `lastKnownStatus` is now purely informational, populated by `_bodhi-pi/mcp/connect`/`disconnect` calls for UI display. The connection ground-truth lives in the host's `McpConnectionProvider`.
  - **Update** the "MCP connection continuity is host-policy" section to point at the new `McpConnectionProvider` interface and list the per-host implementations.
- Remove any dead `BODHI_PI_E2E_DEEPWIKI_HTTP_URL` / `BODHI_PI_E2E_UI_DEEPWIKI_HTTP_URL` env var plumbing left in `global-setup.ts` files.
- Run the full e2e suite (`npx vitest --run --config vitest.e2e.config.ts` across all 4 projects) + full Playwright (`cd packages/bodhi-pi/e2e-ui && npm test`) as a green-light bar.

**Slice 7 gate**: all vitest projects + all Playwright projects green; no `runIf` skips for MCP under http.

---

## Critical files reference

| File | Slice(s) |
|---|---|
| `src/mcp/mcp-connection-provider.ts` (new) | 0 |
| `src/mcp/in-process-provider.ts` (new) | 0 |
| `src/mcp/mcp-service.ts` | 0 |
| `src/mcp/mcp-registry.ts` | 0 |
| `src/sessions/entries.ts` | 0 |
| `src/sessions/build-context.ts` (~L92–95) | 0 |
| `src/sessions/session-bootstrap.ts` | 0 |
| `src/acp/agent.ts` (L65, L332, L414, L431) | 0 |
| `src/index.ts` | 0 |
| `test/mcp.test.ts` | 0 |
| `e2e/shared/mcp-session-resume.e2e.ts` (new) | 1 |
| `e2e/cli-headless/mcp-session-resume.e2e.ts` (new) | 2 |
| `test-apps/http/src/server/mcp/server-mcp-store.ts` (new) | 3 |
| `test-apps/http/src/server/agent/wire-agent.ts:125` | 3 |
| `e2e/shared/mcp-public-http.e2e.ts` un-gate | 3 |
| `e2e/shared/mcp-multi.e2e.ts` un-gate | 3 |
| `e2e-ui/shared/mcp-public-http.spec.ts` | 3 |
| `e2e-ui/shared/mcp-multi.spec.ts` + `e2e-ui/global-setup.ts` | 3 |
| `test-apps/http/src/server/agent/wire-agent-ws.ts:109` | 4 |
| `test-apps/browser/src/ui-lib/runtime/storage-backed-provider.ts` (new) | 5 |
| `test-apps/browser/src/ui-lib/runtime/bootstrap-worker.ts:173` | 5 |
| `test-apps/chrome-ext/src/...` | 6 |
| `TECHDEBT.md` | 7 |
| `e2e/global-setup.ts` (dead env vars) | 7 |

## Existing utilities to reuse

| Function | Where | Use |
|---|---|---|
| `connectMcp(entry, opts)` | `src/mcp/mcp-client.ts:18` | in-process provider implementation |
| `adaptMcpTool(slug, info, client)` | `src/mcp/mcp-tool-adapter.ts` | provider's `getTools()` returns adapted AgentTool array |
| `appendEntry` dep pattern | `src/models/registry.ts:27,39` | same shape for `McpService`'s entry-write path |
| `walkPath` per-entry switch | `src/sessions/build-context.ts:92` | add `mcp_inclusion_set` branch alongside `model_change` |

## Out of scope

- OAuth-DCR e2e-ui spec — separate plan, fixture: `https://example-server.modelcontextprotocol.io/mcp`.
- Eviction / TTL on the per-user connection store (never-evict for test fixtures).
- Lifecycle of connections during long server idle periods (existing `mcp_status_change` event surfaces drops; consumers can react if they care).
