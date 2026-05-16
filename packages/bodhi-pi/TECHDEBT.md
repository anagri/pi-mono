# bodhi-pi — Tech debt log

Living register of debts taken on deliberately. Each entry: what, why deferred, what the right fix looks like.

---

## `mcp/<slug>.lastKnownStatus` is informational only

**What:** kv stores an `mcp/<slug>.lastKnownStatus` field. After the host-owned-connections refactor, this field is **purely informational** — populated by `_bodhi-pi/mcp/connect` / `disconnect` for `/mcp list` UI display. The behavioral ground-truth for "is this MCP currently connected" lives in the host's `McpConnectionProvider`, not in kv.

**Behavior:** Hosts may consult `lastKnownStatus` at boot to decide which slugs to auto-restore (see "MCP connection continuity" below) — that's host policy, not SDK behavior. The SDK itself never reads the status field after the refactor.

**Cost of the workaround:** None at present — the field is written on connect/disconnect but never read by SDK code paths.

**What the right fix looks like:** Eventually the field can be removed from kv entirely, replaced by ephemeral state in the host's provider. Removing the field is a kv schema migration; not worth the churn until other kv schema work happens.

---

## MCP connection lifecycle is host policy via `McpConnectionProvider`

**What:** The SDK ships an `McpConnectionProvider` interface (`src/mcp/mcp-connection-provider.ts`) and a default `createInProcessMcpConnectionProvider()` factory. Hosts inject their own implementation via `BodhiPiConfig.mcpConnectionProvider` when their lifecycle differs from the default.

**Host implementations in this repo:**
- **`bodhi-pi-cli` / test-apps/in-memory / test-apps/cli**: omit the field, use the SDK default. Connections live with the process.
- **`test-apps/http` (HTTP + SSE per-request rebuild)**: `ServerMcpStore` (`src/server/mcp/server-mcp-store.ts`) maintains a process-scoped `Map<userId, McpConnectionProvider>`. Each per-request agent gets the user's persistent provider so connections survive rebuild.
- **`test-apps/http` (WS, same store)**: same `ServerMcpStore` reused — a user's WS and HTTP sessions share the same connection cache.
- **`test-apps/browser` (Web Worker)**: default in-process provider, but the worker's boot routine (`bootstrap-worker.ts`'s `restoreConnectedMcps`) reads kv on startup and reconnects every entry with `lastKnownStatus === "connected"`. Survives page refresh because kv (Dexie) persists in IndexedDB.
- **`test-apps/chrome-ext`**: shares the worker bootstrap from `test-app-browser` — auto-restore works the same way under the extension's service worker lifecycle.

**Not actually debt** — this is the architecture. Documented here so future contributors know where to add their own restore policy. Eviction / TTL / multi-tenant isolation refinements would go on top of this seam.

---

## MCP inclusion is session state (`mcp_inclusion_set` snapshots)

**What:** `/mcp include` and `/mcp exclude` write `mcp_inclusion_set` snapshot entries to the session log, mirroring the `model_change` pattern. `session/load` and `session/resume` restore inclusion automatically.

**Precedence on `mcpServers` param:**
- `undefined` → use session-stored inclusion (no new entry written).
- `[]` → empty inclusion (only writes an entry if prior inclusion was non-empty — avoids noisy entry on brand-new sessions).
- `[A, B, ...]` → connect+include named slugs that exist in kv (writes new snapshot entry). Unknown slugs are silently skipped (no kv promotion).

**Not actually debt** — documented for clarity on how the model + MCP-inclusion patterns interact.
