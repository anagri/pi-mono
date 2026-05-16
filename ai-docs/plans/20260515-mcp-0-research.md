# MCP Integration: Comparative Research (Zed / opencode / mcp-typescript-sdk)

Source: deepwiki `ask_question` against `zed-industries/zed`, `sst/opencode`, `modelcontextprotocol/typescript-sdk`. Findings below are paraphrased from deepwiki responses; deepwiki rendered file-citation tags but stripped path strings, so where I have a path it is cited, otherwise the citation is `[repo]`. Apparent contradictions are flagged honestly rather than smoothed over.

This is a research document, not an implementation plan. It exists in `ai-docs/plans/` only because plan mode requires writing here.

---

## 1. Architectural split: where does the MCP client live?

**Zed** — Two-layer answer, and the deepwiki responses disagree on framing.

- Deepwiki initially says the MCP client "lives in the editor UI process, not in the agent process," with `ContextServerStore` owning lifecycle and `ModelContextProtocol` / `InitializedContextServerProtocol` instantiated by the editor's context-server infra `[zed]`.
- A follow-up clarifying query revealed that the **native agent and the MCP client are in the same Zed process**. They are not separate processes communicating via IPC. The MCP *servers* (the things the client talks to) run as separate child processes (stdio) or remote (http) — but the MCP **client** is co-located with Zed's native agent inside the Zed binary. `[zed: crates/agent/src/tools/context_server_registry.rs]`
- Reconciling: when the deepwiki answer says "editor UI process," it means "the Zed process, which happens to host the UI and also hosts the native agent." It is not a UI-vs-agent separation; it is a Zed-process-vs-external-process separation. The native agent invokes MCP tools by calling into `ContextServerStore` in-process: `let Some(protocol) = server.client() else { ... }; let request = protocol.request::<context_server::types::requests::CallTool>(...)`. `[zed]`
- For **external agents over ACP**, ownership is different: Zed pushes the MCP-server *configuration* to the external agent via ACP `NewSessionRequest`/`LoadSessionRequest`, and the **external agent owns the MCP client connections itself**. See §9 for the wire shape.
- OAuth callback HTTP server lives in the Zed process (same process as the MCP client) — `HttpTransport` carries an `OAuthTokenProvider` and the session storage is in-process. `[zed]`
- Headless mode exists. `HeadlessProject` carries a `context_server_store` entity, so MCP works without a UI; the architecture is "Zed-process owns MCP client, regardless of whether a UI is attached." `[zed]`

**opencode** — Cleanly server-side.

- opencode has a client/server split (TUI talks to a local opencode server over HTTP). The MCP client lives **entirely in the opencode server process**. The TUI never holds a transport. `[opencode]`
- `StdioClientTransport` is created in `connectLocal`; `StreamableHTTPClientTransport` and `SSEClientTransport` are created in `connectRemote`. Both functions are part of the server-side `MCP.Service` Effect layer. `[opencode]`
- The OAuth callback HTTP server (port 19876) is started by `McpOAuthCallback.ensureRunning()` from inside the server-side `startAuth`. `[opencode]`
- `mcp-auth.json` lives in the global data directory and is accessed by the server-side `McpAuth.Service`. `[opencode]`
- The TUI interacts with MCP only by hitting server HTTP routes such as `/mcp/:name/auth/start` and `/mcp/:name/auth/callback`. Tool execution during inference is entirely server-side. `[opencode]`

**mcp-typescript-sdk** — No opinion. The SDK is just a library; it does not prescribe a process topology. It exposes `Client`, transports, and `OAuthClientProvider`, and lets the host decide where to instantiate them. There are no built-in agent-framework adapters, and no built-in helpers for OAuth callback servers (loopback, popup, or extension flows). `[ts-sdk]`

**Takeaway for bodhi-pi**: there are two valid patterns in the wild. Zed and opencode both put the MCP client on the same side as the model/tool-execution loop. The user-facing surface (Zed editor chrome, opencode TUI) does not own the transport. The strongest argument for this is that tool execution must happen wherever the model loop runs, so the transport must be co-located with the agent. Putting the MCP client in a browser UI tab while the agent runs server-side would mean shipping tool-call args from agent → UI → MCP server and tool results back the same way — neither Zed nor opencode do that.

---

## 2. Transports

**Zed** — Supports stdio and HTTP. The HTTP transport accepts both JSON and `text/event-stream` (SSE) responses through the same `Transport` trait. There is **no distinct `streamable-http` transport type** in Zed's codebase — HTTP transport handles streaming via SSE inline. SSE has **not been deprecated** in Zed. `[zed]`

**opencode** — Supports all three: `StdioClientTransport`, `StreamableHTTPClientTransport`, `SSEClientTransport`. For remote servers, opencode tries `StreamableHTTPClientTransport` first, then falls back to `SSEClientTransport`. **SSE is not deprecated in opencode**; both remain active. `[opencode]`

**mcp-typescript-sdk** — Most explicit on SSE status:

- Supports stdio, Streamable HTTP, SSE. `[ts-sdk]`
- "SSE has been deprecated on the server side but remains available on the client for backwards compatibility. The server-side `SSEServerTransport` was removed entirely in v2. The client-side `SSEClientTransport` is marked deprecated with a note to prefer `StreamableHTTPClientTransport`." `[ts-sdk]`
- The SDK is in v2 (alpha); v1.x remains recommended for production until a stable v2 release in Q1 2026. `[ts-sdk]`

**Takeaway**: stdio is non-negotiable. Streamable HTTP is the future. SSE client should be supported only as a fallback for legacy servers; do not implement an SSE *server* path on the bodhi-pi agent side.

---

## 3. OAuth Dynamic Client Registration (DCR)

All three converge on **lazy DCR**: it is triggered on first connect, not at "mcp add" time. None of them perform speculative DCR.

**Zed** — DCR happens lazily on first connect when the HTTP server returns 401. The transport surfaces `TransportError::AuthRequired`; `authenticate_server()` initiates the flow, which calls `run_oauth_flow()`, which calls `oauth::resolve_client_registration()`. Client credentials and tokens are stored together as a serialized `OAuthSession` in the system keychain under key `mcp-oauth:{canonical_server_uri}` via `credentials_provider.write_credentials()`. Encrypted by the OS (Keychain / Credential Manager / Secret Service). Token refresh updates the persisted session. `[zed]`

**opencode** — DCR happens lazily on first connection if no `clientId` is in the static config. If the server does not support DCR and the user has not configured a `clientId`, opencode emits a warning prompting the user to set one. Credentials and tokens live in `mcp-auth.json` in the global data directory; deepwiki describes the storage as "secure" but did not confirm encryption beyond filesystem permissions. The `McpAuth.Service` owns persistence. `[opencode]`

**mcp-typescript-sdk** — Provides `registerClient()` implementing RFC 7591. The recommended pattern is lazy-on-401: `OAuthClientProvider.clientInformation()` returns existing client info or `undefined`; the SDK's `auth()` function checks for it and runs DCR before authorizing if it is missing. Persistence is delegated to the host via `saveClientInformation()` / `saveTokens()` / `saveCodeVerifier()`. **The SDK does not ship storage**; it is the host's job to wire these to keychain / file / IndexedDB / etc. `[ts-sdk]`

The SDK also handles scope resolution from `WWW-Authenticate` → protected-resource-metadata `scopes_supported` → `clientMetadata.scope`, applying the resolved scope to both DCR and the authorization request. `[ts-sdk]`

**"Added but not connected" state**: Zed has it explicitly via `ContextServerState` enum with `AuthRequired`, `Authenticating`, `Running`, `Error` variants. `[zed]` opencode also tracks status per server (`connected`, `failed`, `needs auth`, etc.) and shows it in `opencode mcp list` and the TUI sidebar. `[opencode]` The SDK has no such notion; it is a host concern.

---

## 4. OAuth callback handling per runtime

This is where the repos diverge most, and where the SDK is least helpful.

**CLI / TUI** — opencode is the clean reference:

- `McpOAuthCallback.ensureRunning()` boots an ephemeral HTTP server bound to `127.0.0.1:19876` (configurable via `oauthConfig?.redirectUri`). The browser is opened, the user authorizes, the AS redirects to that port, opencode captures the authorization code, exchanges it, persists tokens, and tears the server down. `[opencode]`
- Zed similarly runs a callback server in-process; deepwiki did not give a specific port. `[zed]`
- The TS SDK explicitly provides **no** built-in loopback helper. Hosts must implement their own ephemeral server and call `transport.finishAuth(code)`. `[ts-sdk]`

**Browser web app (SPA)** — Neither Zed nor opencode have a browser-app surface. The SDK confirms **no examples in the repo for `window.postMessage` / `BroadcastChannel` handoff between auth tab and main tab**. `[ts-sdk]`

> Direct quote from deepwiki on the SDK: "For SPAs: Implement `redirectToAuthorization()` to open a popup and use `window.postMessage` to communicate the authorization code back."

That is guidance, not a shipping example. For bodhi-pi's browser host this is greenfield — you choose the channel (postMessage from a popup, BroadcastChannel between same-origin tabs, or a same-origin route that writes to localStorage and dispatches a `storage` event). None of the three reference repos solve this; you cannot crib a pattern.

**Chrome extension** — Same story, only worse:

- Zed: not applicable (desktop app, not an extension).
- opencode: not applicable.
- TS SDK: **no guidance for extensions** in the repo. The deepwiki response suggests `chrome.identity.launchWebAuthFlow` or a custom URI scheme as the obvious path, but this is the model's general knowledge, not anything from the SDK. `[ts-sdk]`

For an extension, the practical options are: (a) `chrome.identity.launchWebAuthFlow` with `https://<extension-id>.chromiumapp.org/` as the redirect URI — this requires the MCP server's OAuth registration to accept that origin, which DCR can solve if the AS supports it; (b) a companion native-messaging host running an ephemeral loopback server; (c) opening a separate tab to a static callback page that posts the code back to the extension via `chrome.runtime.sendMessage`.

---

## 5. State persistence

**Zed** — System keychain. Keyed by `mcp-oauth:{canonical_server_uri}`. Stores the full `OAuthSession` (tokens + client registration) as a serialized blob. Encrypted by OS. `ContextServerState` enum tracks runtime status (`Running`, `AuthRequired`, `Authenticating`, `Error`) in memory; persistent config lives in Zed settings (JSON). `[zed]`

**opencode** — `mcp-auth.json` in the global data directory. Holds DCR client credentials and OAuth tokens. Server configs live separately in opencode's config files. Status (`connected` / `failed` / `needs auth`) is in-memory in the `MCP.Service` `s.status` map and surfaced via the TUI sidebar and `mcp list`. `[opencode]`

**mcp-typescript-sdk** — Zero storage. `OAuthClientProvider` is a contract; hosts plug in whatever backend (localStorage, file, keychain, sqlite). The SDK persists nothing. `[ts-sdk]`

**Encryption**: Zed gets it for free via OS keychain. opencode does not appear to encrypt `mcp-auth.json` beyond filesystem permissions (deepwiki hedged on this). The SDK leaves it to you.

**"Added but not connected"**: yes in both Zed and opencode (see §3). Both treat config and connection state as separate concerns: a server can be in config with status `AuthRequired` / `failed` / `disabled` and not currently have a live transport.

---

## 6. Tool surfacing to the LLM

All three converge on **native tool registration**, not system-prompt injection.

**Zed** — MCP tools are wrapped in `ContextServerTool` which implements `AnyAgentTool`. The wrapper exposes schema + metadata to the model and routes `CallTool` requests through `ContextServerStore` to the appropriate MCP server protocol client. Tool names are **namespaced by server id** with format `mcp:<server_id>:<tool_name>` — explicit, colon-delimited, three-part. This prevents collisions with built-in tools (`terminal`, `read_file`, etc.) and is enforced consistently across permissions, tool registration, and UI. `[zed: crates/agent/src/tools/context_server_registry.rs, crates/agent/src/tool_permissions.rs]`

**opencode** — Tools are converted via `convertMcpTool()` into AI SDK `Tool` objects (so they slot into the standard Vercel-AI-SDK tool surface). Tool names are namespaced as `<sanitize(serverName)>_<sanitize(toolName)>` — underscore-delimited, two-part, with non-alphanumeric chars (except `-` and `_`) replaced by `_`. So `my-tool` from server `my.special-server` becomes `my_special-server_my-tool`. The schema is forced to `type: "object"`, `additionalProperties: false`. `MCP.tools()` filters to connected clients and returns the merged record. `[opencode]`

**mcp-typescript-sdk** — Provides no namespacing helper. Each `McpServer` instance owns its own `_registeredTools`. Multi-server composition (namespacing, dedup, conflict resolution) is explicitly a host concern. The SDK ships thin runtime adapters (`@modelcontextprotocol/express`, `@modelcontextprotocol/hono`, `@modelcontextprotocol/node`) but no agent-framework integrations. `[ts-sdk]`

**Two distinct namespacing conventions to choose from**: Zed's `mcp:server:tool` (colon, three-part, MCP-prefix-tagged) versus opencode's `server_tool` (underscore, two-part, sanitized). Opencode's is friendlier to LLMs that have trouble with colons in tool names; Zed's is more disambiguated and visually distinct from built-in tools. Both are defensible.

---

## 7. Connection lifecycle

The two repos disagree here, which is one of the more interesting findings.

**Zed — lazy.** "`ContextServerStore` manages server lifecycle through a `run_server` method that starts servers on demand." Servers start when first needed, not at session init. `[zed: crates/project/src/context_server_store.rs]` Reconnect/error handling: the store can restart servers; for HTTP/OAuth servers it has explicit session management, can refresh stored OAuth sessions on reconnect, and `logout_server` clears keychain state and recreates the transport. `[zed]`

**opencode — eager.** "The MCP service does **not** eagerly connect all servers at startup. Instead, connections are established on-demand when `MCP.create()` or `MCP.add()` is explicitly called." But the follow-up clarifies: `MCP.add()` connects synchronously within the call, and at session start opencode calls `create` for each configured server, so the practical effect is eager-connect-all-on-session-start. `MCP.tools()` is purely a read over already-connected clients; it does **not** trigger new connections. `[opencode]` On failure, status is persisted in-memory as `{ status: "failed", error: lastError.message }`, a toast is fired (`"Server requires authentication. Run: opencode mcp auth {key}"` for auth errors), and **there is no automatic retry**. The failure stays until the user re-runs `mcp connect` or `mcp add`. `[opencode]`

**mcp-typescript-sdk** — On lifecycle: Streamable HTTP **requires** an `Mcp-Session-Id` header on every post-init request; servers reject requests without it. Clients can preserve `sessionId` across reconnects via `StreamableHTTPClientTransportOptions`; when reconnecting with a preserved session id, also pass `protocolVersion` matching the negotiated handshake. Graceful disconnect: call `transport.terminateSession()` then `client.close()`. Reconnect backoff is customizable via `ReconnectionScheduler` for non-standard runtimes (serverless, mobile, etc.). `[ts-sdk]`

**Status notifications to UI**: opencode emits `TuiEvent.ToastShow`; Zed updates `ContextServerState` which the agent-configuration UI subscribes to. Neither defines a generic protocol-level status event — both are host concerns.

**Tradeoff**: eager (opencode) gives accurate `mcp list` status up front and a clean "everything ready" moment, but slows session startup and wastes resources if many servers are configured but rarely used. Lazy (Zed) is faster to boot and cheaper, but `mcp list` can only show "configured" not "healthy" without a separate probe, and first-tool-call latency spikes.

---

## 8. User-facing surfaces

**Zed** — GUI affordances:
- "Add Server" button in agent configuration with "Add Custom Server" or "Install from Extensions" `[zed: crates/agent_ui/src/agent_configuration.rs]`
- "Model Context Protocol (MCP) Servers" section in agent settings
- Tool picker UI: select individual MCP tools per profile `[zed: crates/agent_ui/src/agent_configuration/tool_picker.rs]`
- "Configure MCP Tools" entry in profile management modal `[zed: crates/agent_ui/src/agent_configuration/manage_profiles_modal.rs]`
- Status indicators on each server; warning when a model does not support all of a server's tools `[zed: docs/src/ai/agent-panel.md]`

**opencode** — CLI commands, with a TUI sidebar reflection:
- `opencode mcp list` — status indicators: ✓ connected, ⚠ needs auth, ✗ failed
- `opencode mcp auth [name]` — interactive OAuth login for remote servers
- `opencode mcp logout [name]` — removes stored OAuth credentials
- `opencode mcp debug` — verbose logs
- `opencode mcp add` — interactive add flow
- TUI sidebar shows MCP status via `MCP.status()`
`[opencode]`

**Idempotency / partial failures**: opencode's eager-connect approach handles partial failure cleanly: one server failing does not block the others. Each lands in its own status slot. There is no auto-retry, so a transient network blip leaves a server stuck `failed` until the user intervenes. Zed's lazy approach side-steps the partial-failure problem at session start, but a server that fails *during* a session leaves the user to discover it via `AuthRequired` state in the panel.

---

## 9. ACP–MCP interplay (Zed)

This is the most specific finding of the research.

**ACP carries MCP server configs.** Zed's `mcp_servers_for_project()` builds `Vec<acp::McpServer>` from the project's `ContextServerStore` and attaches it to both `NewSessionRequest` and `LoadSessionRequest` via `.mcp_servers(mcp_servers)`. The external agent receives the configuration and **manages its own MCP connections independently**. `[zed]`

**Wire shape** (paraphrased from deepwiki — protobuf/Rust enum, two variants):

`acp::McpServer::Stdio` carries:
- `id` — server name (string)
- `command` — executable path
- `args` — list of args
- `env` — list of `acp::EnvVariable { name, value }`

`acp::McpServer::Http` carries:
- `id` — server name (string)
- `url` — server URL
- `headers` — list of `acp::HttpHeader { name, value }`

**Critical: Zed does NOT pass OAuth bearer tokens to external agents.** Direct paraphrase: "Zed manages OAuth tokens for its own MCP server connections, but when communicating with external agents via ACP, it only provides the static configuration (URL and headers) that was set up in settings." Headers may include a static `Authorization: Bearer <token>` if a user hard-coded it in settings, but Zed's own dynamically-obtained OAuth tokens stay in Zed's keychain and are not forwarded. The external agent does its own OAuth flow against the same MCP server URL. `[zed]`

**Implication for bodhi-pi**: if you adopt ACP-style external agents, expect each external agent to do its own DCR, its own callback handling, its own token storage. The host (bodhi-pi) only ships static config. That means each agent process needs the full OAuth stack — there is no "single sign-on for MCP across agents." If you want shared OAuth, you must extend ACP with a token-exchange primitive (not present in mainline ACP per these findings) or accept duplicated auth flows.

---

## 10. Pitfalls / non-obvious lessons

Deepwiki cannot reliably surface PR history from snapshots, so this section is thinner than the others. What did come through:

**From the TS SDK**:
- **Single-retry OAuth refresh**: `AuthProvider.token()` is called before every request; on 401, `AuthProvider.onUnauthorized()` runs once to refresh, then the request retries **once**. If the retry also 401s, `UnauthorizedError` is thrown. If your refresh is slow or flaky, the single retry is not enough — you must implement your own retry inside `onUnauthorized()`. `[ts-sdk]`
- **SSE disconnection mid-call** (SEP-1699 test case): a Streamable-HTTP server can close the SSE stream mid-tool-call; the client must reconnect and retrieve the result. The SDK supports this via `ReconnectionScheduler`, but the host must implement appropriate retry logic.
- **Session-id discipline**: on Streamable HTTP, every non-init request must carry the negotiated `Mcp-Session-Id` header. If you reconnect and forget to also restore `protocolVersion`, the new transport will be missing the header on subsequent calls. Subtle and easy to break.
- **Multi-server composition is your problem**: namespacing, dedup, and conflict resolution across servers is not solved by the SDK. If you naively merge `tools/list` outputs from two servers, you can ship duplicate tool names to the LLM.
- **Idempotent session init**: the server transport calls `onsessioninitialized` immediately after init when a session id is present. If your init handler is not idempotent / thread-safe, concurrent connections can corrupt session tracking. `[ts-sdk]`

**From Zed**:
- The `logout_server` flow explicitly recreates the transport (rather than just clearing tokens) to ensure a stale token does not linger on an open connection. Suggests they encountered "old token still attached after refresh" bugs. `[zed]`
- The namespacing prefix `mcp:` is enforced consistently across permissions, tool registration, and UI — suggests early collisions with built-in tools forced the rule. `[zed]`

**From opencode**:
- Tool name sanitization (non-alphanumeric → `_`) is forced because some LLM tool-call APIs reject names containing `.`, `:`, or other punctuation. The sanitizer is the lesson learned. `[opencode]`
- The transport fallback order (`StreamableHTTPClientTransport` then `SSEClientTransport`) handles servers that advertise streamable-http endpoints but actually only implement SSE, or vice versa. Real-world MCP servers are inconsistent. `[opencode]`
- No auto-retry on failed connect: a deliberate choice. Auto-retry on a misconfigured server creates a flood of error toasts; opencode forces explicit user action via `mcp auth` / `mcp add`. `[opencode]`

**Not findable via deepwiki**: specific PR numbers and commit-level fix history. The deepwiki tool acknowledged this limitation on both Zed and opencode queries — it cannot reliably surface git history from snapshots. To get the PR-level lessons you would need to grep GitHub directly (e.g. `repo:zed-industries/zed mcp in:title is:pr is:merged` and similar).

---

## Synthesis for bodhi-pi (no recommendation, just options laid bare)

These are the discrete choice axes the research surfaces. Each axis has a defensible answer from at least one of the reference repos; bodhi-pi's 4-package matrix (core + node/browser adapters + cli/web hosts) constrains some choices more than Zed or opencode are constrained.

**Process placement of MCP client.** Both Zed and opencode put the MCP client on the same side as the model loop. For bodhi-pi this means: agent-side (whatever process runs the agent loop), not in the browser/extension UI. For the browser host, this implies the agent must run in a service worker or backend, with MCP transports living there — the page tab is only a UI.

**Transports.** Stdio (node host only — extension/browser cannot spawn processes), Streamable HTTP (all hosts), SSE client fallback (all hosts). Do not implement an SSE server.

**DCR.** Lazy-on-401 across all three references. Same recommendation.

**Storage.** Node: OS keychain via something like `keytar`, or fall back to a permission-restricted JSON file (opencode-style). Browser: IndexedDB with an explicit "this is not secure storage" disclaimer in the UI. Extension: `chrome.storage.local` with the same disclaimer, or `chrome.identity` token cache if using `launchWebAuthFlow`. The TS SDK's `OAuthClientProvider` interface is the right abstraction to slot these behind.

**OAuth callback per host.**
- CLI: ephemeral loopback HTTP server, opencode-style.
- Web: same-origin callback route + BroadcastChannel or postMessage for popup-to-app handoff. No reference impl in any of the three repos; greenfield.
- Extension: `chrome.identity.launchWebAuthFlow` with `https://<extension-id>.chromiumapp.org/`. No reference impl in any repo; greenfield.

**Tool namespacing.** Pick one of Zed's `mcp:server:tool` (explicit, three-part, colon-delimited) or opencode's `sanitize(server)_sanitize(tool)` (two-part, underscore, LLM-friendly). Whichever you pick, enforce it consistently across permissions, UI, and tool-call routing — Zed's choice to enforce in three places hints at the cost of inconsistency.

**Connection lifecycle.** The eager-vs-lazy split is real and bodhi-pi has to pick. Eager (opencode) gives accurate status up front and clean partial-failure semantics, at the cost of session-start latency. Lazy (Zed) is cheaper to boot but defers status discovery.

**ACP carrying MCP config.** If bodhi-pi exposes itself as an ACP host (driving external agents the way Zed does), the precedent is to ship MCP-server config — but not tokens — in `NewSessionRequest`/`LoadSessionRequest`. Each external agent does its own OAuth. There is no shared-token-across-agents primitive in the wild.

---

## Citations

All findings above paraphrased from deepwiki `ask_question` calls against:
- `zed-industries/zed` — multiple queries covering architecture, transports, OAuth, lifecycle, ACP shape, native vs external agent split. File paths cited inline where deepwiki returned them.
- `sst/opencode` — queries covering architecture, transports, OAuth callback, eager-vs-lazy, namespacing, failure handling, CLI surface.
- `modelcontextprotocol/typescript-sdk` — queries covering transport status, OAuth `Client` provider contract, session-id discipline, multi-server composition, pitfalls.

Where deepwiki acknowledged it could not answer (PR-level history, browser SPA examples, extension OAuth guidance), this document says so rather than speculating.
