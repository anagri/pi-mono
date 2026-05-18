# bodhi-pi

An embeddable, runtime-agnostic AI coding agent that speaks the **Agent Client Protocol (ACP)**. The agent owns the LLM prompt loop, tool registry, and session state; everything platform-specific (filesystem, persistence, script execution, terminal, key-value store, MCP transports) is injected by the **Host**. Reference Hosts live in `test-apps/{cli,http,browser,chrome-ext}/`.

## Language

### Roles & processes

**Agent**:
The in-process `BodhiPiAcpAgent` instance constructed by `createBodhiPiAgent(config)`. Owns the prompt loop, tool registry, session state, ACP method dispatch.
_Avoid_: "core", "engine".

**Host**:
The process that **embeds** the Agent. Builds the dependency graph (Filesystem, SessionStore, KvStore, ScriptExecutor, Terminal, McpConnectionProvider, extension factories) and exposes the agent over a **Transport** as an ACP `AgentSideConnection`.
_Avoid_: "server", "backend" (a Host may be a CLI process or a Web Worker — not a server).

**Client**:
Everything on the Client side of the ACP **Transport** — the `ClientSideConnection` peer that sends requests (`prompt`, `extMethod`, …) and consumes `sessionUpdate` notifications, **plus** the transport-client adapters (http fetch+SSE, ws stream, MessagePort wiring) and **plus** the user-facing rendering surface (REPL, React app, popup, chrome-ext page) and slash UX. In each Reference Host the Client-side code lives under `test-apps/<host>/src/client/` with canonical sub-folders `client/{react,acp,deps,lib}/`. In single-process Hosts (cli, browser-worker, chrome-ext) Host and Client run in the same OS process linked by an in-process Transport; in split Hosts (http, ws) the Client runs in a remote browser tab.
- **UI** is the rendering subset of Client (React components, REPL renderer, popup pages). Lives under `client/react/` (or equivalent). The folder name is `client/` because the broader concept is what owns the seam; `ui/` would understate scope.

_Avoid_: "frontend" alone (a Frontend is the rendering layer = UI = a subset of Client); "client" lowercase when you mean the rendering layer (use **UI**).

**Reference Host**:
One of the four canonical Hosts shipped under `test-apps/`: cli, http, browser, chrome-ext. Each proves end-to-end feature parity for a distinct runtime profile.

**Transport**:
The wire over which ACP messages travel. In bodhi-pi: stdio/in-process (cli + in-memory), HTTP+SSE or WebSocket (http), MessagePort (browser, chrome-ext).
_Avoid_: "protocol" (that's ACP).

### ACP surface

**ACP method**:
A first-class method named by the ACP spec — `initialize`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/close`, `session/prompt`, `session/cancel`, `session/setSessionConfigOption`.

**Extension method**:
A non-spec method namespaced `_bodhi-pi/<area>/<verb>` (e.g. `_bodhi-pi/session/fork`, `_bodhi-pi/mcp/connect`). Dispatched through ACP's generic `extMethod` channel. Capability is advertised via `agentCapabilities._meta["bodhi-pi"]`.
_Avoid_: "custom method", "private method", "unstable method".

**Session update**:
An ACP `session/update` notification streamed from Agent to Client. Carries assistant chunks, tool-call frames, tool-result frames, available-commands refreshes, MCP status broadcasts, etc.

### Session model

**Session**:
A conversation context identified by `sessionId`, anchored to a `cwd`. Persisted as an append-only stream of **Session Entries**.

**Session Entry**:
One row in the session log. The discriminated union `SessionEntry` is the canonical persistence unit. Each entry has `id`, optional `parentId`, `timestamp`, and a `type` tag (`message`, `model_change`, `thinking_change`, `mcp_inclusion_set`, `compaction`, `branch_summary`, `session_info`, `extension`, `custom_message`).

**Session DAG**:
The directed acyclic graph formed by entries linked via `parentId`. A session has many leaves; the **Leaf** is the tip of the currently-active branch.
_Avoid_: "history" (history is the linear projection from root to leaf).

**Branch**:
The path from root to a given leaf. **Fork** creates a new branch by rewinding to a chosen entry; **Clone** duplicates the active branch under a new `sessionId`; **Navigate** switches the active leaf.

**Branch summary**:
An auto-appended `branch_summary` entry written when a cross-branch `/goto` would otherwise lose conversational context. The abandoned tail is summarised into the new branch.

### Configuration & state

**BodhiPiConfig**:
The host-supplied dependency bundle passed to `createBodhiPiAgent`. Required: `sessionStore`, `filesystem`. Optional but routinely supplied: `kvStore`, `scriptExecutor`, `terminal`, `models`, `defaultModelId`, `extensionFactories`, `mcpConnectionProvider`, `homeDir`, `supportsMcpStdio`.

**Settings layer**:
One of `defaults < global < project < host-explicit < session`. `global` = `<homeDir>/.bodhi-pi/settings.json` (Node Hosts only). `project` = `<cwd>/.bodhi-pi/settings.json` (walked from cwd upward). `host-explicit` = fields set on `BodhiPiConfig`. `session` = mutations via `setSessionConfigOption`.

**Session state**:
In-memory per-session record (`SessionState`) holding the pi-agent-core `Agent`, current model, thinking level, tool list, command/skill lists, runtime flags (`cancelled`, `leafId`). Reconstructed at `loadSession`/`resumeSession`.

### Contribution sources

**Extension**:
A host-loaded JS factory (`RegisteredExtension`) that runs in-process inside the Agent. Via `ExtensionAPI` it may register Tools, slash Commands, Providers, and Event handlers, and may append custom Session Entries.
_Avoid_: "plugin".

**Skill**:
A markdown document in `<cwd>/.bodhi-pi/skills/<name>/SKILL.md` with frontmatter (`name`, `description`, `disable-model-invocation`, `allowed-tools`). Available as a `skill:<name>` slash command and (when model-invocable) advertised to the LLM.

**Command**:
A markdown prompt template in `<cwd>/.bodhi-pi/commands/<name>.md` (optionally nested). Frontmatter declares `description` and `argument-hint`; the body is expanded on slash-command invocation with `$1`/`$@`/`$ARGUMENTS`.

**Sub-agent profile**:
A markdown definition in `<cwd>/.bodhi-pi/agents/<name>.md` declaring a specialist child agent. Frontmatter: `description`, optional `model`, optional `tools` allowlist, optional `max-turns`. Body is the child's system prompt. Discovered via `loadProjectSubagents` and exposed through the first-party `subagent` built-in tool (which is registered only when at least one profile exists).
_Avoid_: "agent" alone (overloaded with the bodhi-pi Agent role); always say "sub-agent profile" or "child agent".

**Child session**:
A real `SessionRecord` created by `SubagentService.spawn` with `parentSessionId` set to the parent session and `subagent: { profileName }` denormalized for filterability. Hidden from default `SessionStore.list()` to keep the user-visible session list clean; opt in with `list({ includeSubagentChildren: true })`. Each child has its own session log, its own piAgent, and its own ACP `sessionId` (so it can be loaded/resumed independently).
_Avoid_: "fork" (a Sub-agent Session is created with `subagent` set; a Fork is created without).

**Sub-agent depth**:
Number of `subagent_link` SessionEntry rows in the chain from a child back to its root parent. Hard-capped at 2 in v1 (C2); `SubagentService.spawn` rejects deeper recursion. The child's tool list excludes the `subagent` tool unconditionally as a belt-and-suspenders guard.

**MCP server**:
An external tool provider speaking the **Model Context Protocol**. Persisted under KV key `mcp/<slug>`. Transports: `http` (Streamable HTTP, all runtimes) and `stdio` (Node-spawnable Hosts only). HTTP auth is a top-level discriminator `auth: "public" | "http-param" | "oauth-preregistered"`; `"http-param"` carries sibling `headers`/`queries`; `"oauth-preregistered"` carries pre-issued `clientId`/`clientSecret` plus explicit `authorizeUrl`/`tokenUrl` and runs an OAuth 2.1 authorization-code-with-PKCE flow. All secret values are stored as `McpNamedSecret` and masked on ACP reads.
_Avoid_: "MCP" alone for the server (use "MCP server"); "MCP" alone for the connection (use "MCP connection").

**Slug**:
The stable per-host identifier for an MCP server, derived from URL host or command path; resolved to uniqueness on `_bodhi-pi/mcp/add`.

**Inclusion set**:
The per-session set of MCP slugs whose tools are exposed to the Agent. Connections are global (one per `<host, slug>`); visibility is per-session. Persisted as the latest `mcp_inclusion_set` entry on the active branch.

**OAuth (mode: "oauth")**:
The persisted OAuth shape. Stored under `mcp/<slug>.auth` with `{mode: "oauth", authorizeUrl, tokenUrl, clientId, clientSecret?, scopes?, redirectUri?, tokenAuthMethod?, tokens?, dcrInfo?}`. Two `/mcp add` input variants land in this shape: `auth: "oauth-preregistered"` (user supplies credentials directly) and `auth: "oauth-dcr"` (server runs RFC 9728 + 8414 discovery and RFC 7591 dynamic client registration to obtain credentials). Both then run the same OAuth 2.1 authorization-code-with-PKCE flow driven by the SDK's `auth()` orchestrator. bodhi-pi pre-populates `OAuthClientProvider.discoveryState()` with the persisted URLs and returns `undefined` from `validateResourceURL` to skip RFC 8707 resource indicators per the bodhi-pi contract. The flow runs over five ACP extension methods: `_bodhi-pi/mcp/oauth/start` (build provider, capture authorize URL, persist PKCE codeVerifier under a CSRF state token in `OAuthStateKv`), `oauth/finish` (validate state, exchange code for tokens, persist), `oauth/cancel` (drop state entry), plus two pure-operation helpers `oauth/discover` (RFC 9728 + 8414) and `oauth/register` (RFC 7591) for fine-grained client workflows.

**OAuthStateKv**:
A short-TTL kv wrapper under `mcp/oauth-state/<state>` storing the in-flight `codeVerifier`, `redirectUri`, and `slug` for a single OAuth flow. The state token doubles as a CSRF guard and as the routing key for multi-tenant `GET /oauth/callback` handlers (HTTP runtime). Default TTL 5 minutes; opportunistically pruned on every write.

**DCR (Dynamic Client Registration)**:
RFC 7591 client registration. `/mcp add` with `auth: "oauth-dcr"` runs RFC 9728 (`/.well-known/oauth-protected-resource`) → RFC 8414 (`/.well-known/oauth-authorization-server`) → RFC 7591 (`POST <registration_endpoint>`) to discover the OAuth server and mint a fresh `client_id`/`client_secret` pair. Every step is individually overridable: `clientId` override skips DCR entirely; `authorizeUrl`/`tokenUrl`/`registrationEndpoint` overrides each skip the corresponding discovery step. The result persists as `mode: "oauth"` with a populated `dcrInfo` field tracking provenance (`issuerUrl`, `registrationEndpoint`, `registeredAt`, `registrationAccessToken?`). Standalone `oauth/discover` + `oauth/register` ACP methods are also exposed for client-side workflows that want to inspect results before persisting.

**oauth-event-bus** (browser/chrome-ext runtimes):
Module-level emitter in `test-apps/browser/src/client/lib/oauth-event-bus.ts` shared between AppShell's lifecycle-event pump and the chat `/mcp oauth start` slash. Lets the slash resolve on EITHER the popup `postMessage` (browser-style completion: redirect_uri lands on our React route) OR the `mcp_oauth_status_change` lifecycle notification (HTTP+WS-style completion: redirect_uri lands on the server's `/oauth/callback`, server completes silently and emits the event over SSE/WS). One race covers both runtime topologies — without it, the slash would hang waiting for postMessage on HTTP+WS.

### Built-ins & tools

**Built-in tool**:
A tool implemented inside `src/tools/` and registered unconditionally (e.g. `read`, `write`, `edit`, `ls`, `find`, `grep`) or conditionally on capability (`run_script` when `scriptExecutor` is set; `bash` when `terminal` is set).

**MCP tool**:
A tool surfaced by a connected MCP server, namespaced `<slug>__<original-name>` and merged into the per-session tool list via `McpRegistry.applyToSession`.

**Extension tool**:
A tool registered by an Extension via `registerTool`; adapted into the pi-agent-core tool list with the same merge step.

### Persistence

**SessionStore**:
Host-injected interface for session CRUD + append + leaf tracking + list/pagination. Implementations: in-memory (`createInMemorySessionStore`), Node SQLite (`node-adapters` test-app's wrappers), Dexie (browser).

**KvStore**:
Host-injected key-value primitive with a `secret` hint. Values tagged `secret: true` are **masked to `***` on ACP reads** but readable unmasked by internal callers (e.g. `getApiKey`). Stores: API keys (`auth/<provider>`), MCP entries (`mcp/<slug>`), MCP OAuth credentials if/when re-introduced.

**ConnectionProvider** (MCP):
Host-injected interface that owns MCP transport lifecycle and per-`<host, slug>` connection state. Default `createInProcessMcpConnectionProvider()` is fine for single-tenant embedded Hosts; multi-tenant Hosts (http) inject a provider bound to per-user storage.

## Relationships

- An **Agent** is constructed by exactly one **Host**.
- A **Host** advertises the **Agent** to one or more **Clients** over a single **Transport**.
- A **Session** belongs to exactly one **SessionStore**; it is loaded into at most one **Agent** instance at a time.
- A **Session DAG** has one root, many **Branches**, one active **Leaf** at a time.
- An **MCP server** is global per `<host, slug>`; its visibility in a **Session** is governed by that session's **Inclusion set**.
- **Extensions**, **Skills**, **Commands**, **MCP tools**, and **Sub-agent profiles** all contribute into the same per-session tool/command registries but via independent mechanisms (in-process factory, markdown discovery, markdown discovery, wire-protocol, and markdown discovery respectively).
- A **Child session** belongs to exactly one parent session, links via `parentSessionId` + `subagent: { profileName }`, and is created and managed by `SubagentService.spawn` (C2).
- A **Session Entry** with type `branch_summary` is appended automatically when a Client navigates across **Branches** in a way that would otherwise lose context.

## Example dialogue

> **Dev:** "When the Browser Host disconnects and the user reopens the tab, does the agent re-spawn the MCP servers from before?"
> **Architect:** "On `session/load` or `session/resume` the Agent reads the persisted `mcp_inclusion_set` entry and asks the **ConnectionProvider** to connect each included **slug** — but the provider may already hold those connections from a previous session in the same Host. The slug's `lastKnownStatus` decides whether we auto-connect."
>
> **Dev:** "And what about the http Host, which throws the agent away every turn?"
> **Architect:** "Same flow, but the http Host injects a per-user `ServerMcpStore` as the **ConnectionProvider**, so the SQLite-backed connection survives the rebuild. The new Agent instance reads the same **Inclusion set** entry and re-binds to the existing connections — no reconnect."
>
> **Dev:** "What's the difference between an **Extension** and a **Skill** if both can register slash commands?"
> **Architect:** "An Extension is *code* loaded by the Host's extension factory list — it can run, mutate session state, register tools. A Skill is a markdown document under `.bodhi-pi/skills/` — purely declarative, invoked as `skill:<name>`. They contribute into the same slash-command surface, but Extensions can do anything code can; Skills are bounded prompt-templates."

## Flagged ambiguities

- **"Client" vs "UI"**: previously distinguished as two separate concepts (Client = ACP protocol role; UI = rendering surface). **Resolved by collapse**: **Client** is the broader concept that owns the seam — everything on the Client side of the Transport, including ClientSideConnection, transport-client adapters, slash UX, and the rendering surface. **UI** is a sub-concept of Client (the rendering layer specifically). The operational consequence is the folder split `test-apps/<host>/src/{host,client}/` (NOT `src/{host,ui}/`) tracked by `ai-docs/prompts/2026-05-17-bodhi-pi-test-apps-host-client-split.md`. The future SDK packaging `@bodhiapps/bodhi-pi-client-{...}` follows the same naming.
- **"Host"**: was sometimes used to mean "server". Resolved: **Host** is the agent-embedding process regardless of network topology. A CLI binary and a Node HTTP server are both Hosts.
- **"MCP"**: was overloaded for the protocol, the server, and the connection. Resolved: use **MCP server**, **MCP connection**, **MCP tool** — never bare "MCP".
- **"Custom" vs "extension"**: the `extension` SessionEntry variant is the same concept coding-agent calls `custom`. **Resolved by formalised divergence**: bodhi-pi keeps **extension** for the entry discriminator (`ExtensionEntry`). The name is wired through five store impls plus the `ExtensionRunner` contract; rename would touch the wire shape with no behaviour gain. The divergence from coding-agent is intentional and stable — do not propose a rename.
- **"Reference Host" vs "test-app"**: previously `packages/bodhi-pi-cli` etc. were called reference hosts; they are now **deprecated**. The live reference Hosts are `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext}/`.
