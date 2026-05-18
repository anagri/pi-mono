# Extensions vs Skills vs Commands vs MCP vs Sub-agent profiles

Five ways for capabilities to land in a session. They contribute to the same per-session **tools + slash-commands** surfaces but via independent mechanisms with different trust, persistence, and lifecycle characteristics.

## Side-by-side

| Aspect | **Extension** | **Skill** | **Command** | **MCP server** | **Sub-agent profile** |
|---|---|---|---|---|---|
| Lives where | Host-loaded JS factory | `.bodhi-pi/skills/<name>/SKILL.md` | `.bodhi-pi/commands/<name>.md` | KV under `mcp/<slug>`; external process or HTTP endpoint | `.bodhi-pi/agents/<name>.md` |
| Loaded when | At first `session/new`/`load`/`resume` (lazy `ensureExtensionRunner`) | Per-session at boot (`loadProjectSkills`) | Per-session at boot (`loadProjectCommands`) | At session boot via `mcpService.hydrate` (re-binds existing connections from provider) | Per-session at boot (`loadProjectSubagents`) |
| Discovery | Host passes `extensionFactories: RegisteredExtension[]` into `BodhiPiConfig` | Walk `<cwd>/.bodhi-pi/skills/*/SKILL.md` via injected `Filesystem` | Walk `<cwd>/.bodhi-pi/commands/*.md` via injected `Filesystem` | KV prefix scan (`mcp/`) | Walk `<cwd>/.bodhi-pi/agents/*.md` via injected `Filesystem` |
| Can run code? | **Yes** (full TS factory) | No (markdown only; body is prompt content) | No (markdown only; template expansion) | Yes — but in a remote process, not in-agent | No (markdown only; body is the child's system prompt) |
| Can register tools? | Yes (`registerTool`) | No (an Extension may wrap a Skill; Skills themselves don't expose tools) | No | Yes — surfaced through `mcp-tool-adapter` | Implicit — when any profile exists, the first-party `subagent` built-in tool is registered |
| Can register slash commands? | Yes (`registerCommand`) | Implicit — `skill:<name>` is always advertised when Skill is loaded | Yes (one slash per file) | No — manipulated via `_bodhi-pi/mcp/*` extension methods | No — Hosts implement built-in `/agents` and `/subagent` slashes that call `_bodhi-pi/subagent/*` extMethods |
| Can append SessionEntry? | Yes (`appendEntry` → `ExtensionEntry`; `sendMessage` → `CustomMessageEntry`) | No | No | Only `mcp_inclusion_set` (written by McpStore) | Indirect (C2): `SubagentService.spawn` appends `subagent_link` + `subagent_complete` entries to the child session |
| Hooks lifecycle events? | Yes (`on("tool_call", …)`, `before_provider_request`, …) | No | No | No | No |
| Hot-reload? | No (factory captured at runner build) | Yes (re-walked at next session boot) | Yes (re-walked at next session boot) | Yes (KV writes immediately visible to next operation) | Yes (re-walked at next session boot) |
| Trust boundary | Host code — full agent privileges | Sandboxable text — bounded by skill body + `allowed-tools` | Bounded — template only | Remote — limited by network + auth | Bounded — child runs with profile-constrained tool list (no `subagent` tool; no MCP in v1) |

## Extensions (`src/extensions/`)

Extension factory signature (`src/extensions/types.ts:106`):

```ts
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

The factory receives an `ExtensionAPI` (`src/extensions/types.ts:81-97`):

```ts
interface ExtensionAPI {
  on<T>(type: T, handler): () => void;                 // lifecycle hooks
  registerTool<P>(def: ExtensionToolDefinition<P>): () => void;
  registerCommand(name, def: ExtensionCommandDefinition): () => void;
  registerProvider(name, config: ProviderConfig): () => void;
  events: ExtensionEventBus;                           // inter-extension pub/sub
  appendEntry(sessionId, payload): Promise<void>;      // → ExtensionEntry
  sendMessage(sessionId, content): Promise<void>;      // → CustomMessageEntry
  requestSlashableRefresh(sessionId): Promise<void>;
}
```

**Headless by design.** Extensions cannot register keyboard shortcuts, status bar items, or message renderers. The agent has no TUI; rendering is the UI's responsibility. (Coding-agent's `ctx.ui.*`, `registerFlag`, `registerShortcut`, etc. are intentionally absent — see `src/extensions/types.ts:75-80`.)

**Runner lifecycle.** `ExtensionRunner.build(...)` is invoked from `initialize` (`ensureExtensionRunner` at `src/acp/agent.ts:...`). It:
- runs every factory once
- collects tools/commands/providers/event-handlers
- exposes `getTools()` / `getCommands()` for merge into session state
- exposes `getEventHandlers()` which are appended onto the `EventDispatcher`
- exposes `getExtensionErrors()` for the agent to surface failed names

**Failure policy: per-extension severity.** `RegisteredExtension.required: boolean` (default `false`) controls how `ExtensionRunner.build()` reacts to a factory throw:

- `required: false` (default) — error is captured and logged via the Host-supplied `logger`; the runner proceeds without this extension's contributions. The failed name appears in `initialize` `_meta["bodhi-pi"].extensions.failed[]` so Clients can render a warning UI.
- `required: true` — the first such failure aborts the runner build, which propagates as a `-32603` error from `initialize`. The agent is not usable. Hosts opt into this only when an extension's tools/commands/providers are load-bearing (e.g. the only provider, or a security-gating extension).

Failed names are surfaced via `initialize` `_meta` **regardless** of `required`. Visibility is orthogonal to the abort/continue choice.

**`ProviderConfig`** lets an extension contribute a `Model<Api>` that becomes a valid `setSessionConfigOption("model", id)` target — used by extensions that wrap a custom provider not in pi-ai's catalogue (e.g. a local Ollama at a non-default URL).

**Tool merge precedence**: `mergeTools(builtinTools, extensionTools)` then `mergeTools(session.tools, mcpTools)`. First-registered wins on name collisions; built-ins are unshadowable.

**Command merge precedence**: `mergeCommands(projectCommands, extensionCommands)`. Project commands beat extension commands when names collide.

## Skills (`src/skills/`)

Markdown documents under `.bodhi-pi/skills/<folder-name>/SKILL.md`. Frontmatter:

```yaml
---
name: my-skill              # optional; defaults to folder name
description: ...            # required, ≤1024 chars
disable-model-invocation: false   # optional; when true, skill is slash-only, not LLM-callable
allowed-tools: [read, ls]   # optional; future enforcement (not yet runtime-enforced)
---
<body — system prompt content / instructions>
```

Discovery rules (`src/skills/discovery.ts`):
- Folder-based (not flat `.md` files like Commands).
- `name` must match `^[a-z0-9-]+$`, ≤64 chars, no leading/trailing/double `-`.
- Missing/empty `description` → skill silently dropped (file looks like a draft).
- Sorted by name.

How they reach the LLM:
- Always advertised as `skill:<name>` in `available_commands_update` (`src/acp/agent.ts:146-148`).
- When `disableModelInvocation === false`, included in the system prompt's `<available_skills>` block (built by `composeSystemPrompt`) so the LLM may invoke them autonomously by prefixing its action with the skill name.

`allowed-tools` is parsed and persisted in the `Skill` record but **not yet runtime-enforced** — the permissions phase will add a host-injected `Permissioner` to gate per-tool execution. See PARITY.md "Skill `allowed-tools` runtime enforcement".

## Commands (`src/commands/`)

Markdown prompt templates under `.bodhi-pi/commands/<name>.md` (top-level only — nested subdirs are not currently scanned). Frontmatter:

```yaml
---
description: ...           # optional; defaults to first body line (truncated to 60 chars)
argument-hint: <pattern>   # optional; shown in slash-command UI
---
<body — template with $1 / $@ / $ARGUMENTS placeholders>
```

Loaded by `loadProjectCommands(fs, cwd)` (`src/commands/discovery.ts:48-75`). One file → one `PromptTemplate`. Sorted by name.

**Slash expansion** happens at the Host layer (per-Host slash dispatcher) — the agent only **advertises** commands via `available_commands_update`. When the user types `/my-command arg1 arg2`, the Host expands the template via `expandPromptTemplate(template, args)` (`src/commands/prompt-templates.ts`) and sends the expanded text as a regular `session/prompt`. The agent never sees the slash itself.

This is why bodhi-pi's slash surface is intentionally **flat-and-complete**: every operation has a single direct slash form. No cycle conveniences, no popups. The agent advertises; the Host dispatches. See [bodhi-pi slash design feedback memory](../../../packages/bodhi-pi/CLAUDE.md) for the rationale.

## Sub-agent profiles — see [subagents.md](./subagents.md)

Distinguishing facts vs the above:

- Markdown discovery, like Commands and Skills, but with a different role: a profile is a **specialist child agent definition**. The body is the child's system prompt; the frontmatter constrains its tools, model, and limits.
- Not LLM-callable directly — profiles are invoked via the first-party `subagent` built-in tool (which is registered only when at least one profile is discovered).
- Spawned by `SubagentService.spawn` (C2) into a new durable child Session linked to the parent via `parentSessionId` + denormalized `subagent: { profileName }`.

## MCP servers — see [mcp.md](./mcp.md)

Distinguishing facts vs the above:
- Lives **outside** the agent process; reached via HTTP (Streamable HTTP — deprecated SSE not supported) or stdio (CLI Host only; browser / chrome-ext / http set `supportsMcpStdio: false`).
- Tools are **namespaced** `<slug>__<tool>` to prevent collisions across servers.
- Per-session visibility via **Inclusion set** — globally connected, selectively included.
- Lifecycle owned by a **host-injected ConnectionProvider** so multi-tenant Hosts can survive per-turn rebuilds.

## When to choose which

| You want… | Reach for… |
|---|---|
| A new built-in tool everyone gets | Add to `src/tools/` (modifies bodhi-pi itself, not a contribution) |
| A tool only this project's `cwd` should see | Project-local **Extension** loaded by the Host's extension loader |
| A LLM-callable prompt fragment the LLM can self-invoke | **Skill** |
| A shortcut to type a long prompt | **Command** |
| To integrate with an external tool server (GitHub, filesystem-as-service, browser automation) | **MCP server** |
| To delegate a focused task to a specialist child agent (with its own system prompt, constrained tools, fresh context) | **Sub-agent profile** |
| To run code that observes/modifies tool calls or LLM payloads | **Extension** (`on("tool_call")`, `on("before_provider_request")`) |
| To persist arbitrary structured data on the session log | **Extension** (`appendEntry`) |

## See also

- [acp.md § Extension methods](./acp.md) — full `_bodhi-pi/*` method reference.
- [lifecycle.md § SessionEntry union](./lifecycle.md#sessionentry-union) — where `ExtensionEntry` / `CustomMessageEntry` fit.
- [mcp.md](./mcp.md) — MCP-specific architecture.
- `src/acp/system-prompt.ts` — how skills are spliced into the system prompt.
- `src/extensions/runner.ts` — `ExtensionRunner.build` mechanics.
