# bodhi-pi spec index

Living architecture map for `packages/bodhi-pi/`. Optimised for **AI coding assistants**: terse, link-heavy, citation-first. Pair with [`packages/bodhi-pi/CONTEXT.md`](../../../packages/bodhi-pi/CONTEXT.md) for glossary.

## Read this if…

| Question | Doc |
|---|---|
| What are the moving parts and how do dependencies flow? | [architecture.md](./architecture.md) |
| Which ACP methods (native + `_bodhi-pi/*`) exist and what do they do? | [acp.md](./acp.md) |
| What happens between `session/new` and `session/close`? Where does data live? | [lifecycle.md](./lifecycle.md) |
| How do MCP servers get added, connected, and per-session scoped? Why the recent decomposition? | [mcp.md](./mcp.md) |
| What's the difference between an Extension, a Skill, a Command, and an MCP server? | [extensions-skills-commands.md](./extensions-skills-commands.md) |
| How are the four reference Hosts (`test-apps/{cli,http,browser,chrome-ext}/`) wired? | [hosts.md](./hosts.md) |
| What are the three config surfaces (app-start, disk hierarchy, session-mutable) and how do they compose? | [configuration.md](./configuration.md) |
| What's already in `src/client/` and how will it become `@bodhiapps/bodhi-pi-client-*`? | [client-sdk-seed.md](./client-sdk-seed.md) |
| What does `test/` vs `e2e/` vs `e2e-ui/` cover and which stubs to use where? | [testing.md](./testing.md) |
| Where are the spec ↔ implementation gaps for MCP today? | [mcp-gaps.md](./mcp-gaps.md) |

## Source-of-truth pointers

- Live reference Hosts: `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext}/`. Shared infrastructure: `test-apps/{node-adapters,app-utils}/`.
- **Deprecated**: `packages/bodhi-pi-{cli,web,http,ws-server,ws-frontend,chrome-ext,node,browser}/` are old test apps kept for historical reference only; they are not maintained. New work must land under `test-apps/`.
- Recent major change: MCP refactor decomposing `McpService` into `McpStore` + `McpConnectionLifecycle` + `McpRegistry` + per-tenant `McpConnectionProvider` injection. See [mcp.md](./mcp.md).
- Recent MCP auth re-introduction: after the cleanup pass that briefly left only `auth: "public"`, four input modes are now supported on `/mcp add` — `"public"`, `"http-param"`, `"oauth-preregistered"`, `"oauth-dcr"` — collapsing into the persisted `McpAuthMode = "public" | "http-param" | "oauth"`. OAuth 2.1 (authorization-code + PKCE), RFC 7591 Dynamic Client Registration, and RFC 8414/9728 discovery all run server-side. See [mcp.md § Auth](./mcp.md#auth) and [mcp-gaps.md](./mcp-gaps.md) for known spec gaps.
- Known capability gaps (intentional): stdio MCP is CLI-only and accepts only `auth: "public"` (env vars are the sole credential channel). HTTP transport uses Streamable HTTP exclusively — the deprecated SSE transport from the older MCP spec is not implemented (`mcpCapabilities: { http: true, sse: false }`). See [mcp-gaps.md](./mcp-gaps.md).

## Conventions in these docs

- File:line citations look like `src/acp/agent.ts:339` — clickable in most editors.
- Extension methods are quoted with their full namespace: `_bodhi-pi/<area>/<verb>`.
- Mermaid diagrams render in GitHub and most viewers; LLMs parse the source.
- "Host" / "Client" / "UI" / "Agent" are defined precisely in [CONTEXT.md](../../../packages/bodhi-pi/CONTEXT.md#roles--processes). When in doubt, that doc wins.

## Out of scope here

- ACP protocol itself (see external spec under `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/`).
- `pi-agent-core` internals (see `packages/agent/`).
- `pi-ai` model catalog (see `packages/ai/`).

## Adjacent docs in this repo

- [`packages/bodhi-pi/CLAUDE.md`](../../../packages/bodhi-pi/CLAUDE.md) — operating manual for editing the package (toolchain, comment policy, import policy, key files).
- [`packages/bodhi-pi/PARITY.md`](../../../packages/bodhi-pi/PARITY.md) — feature inventory + per-Host parity status.
- `ai-docs/plans/` — historical decision records; specific plans cross-linked from each spec doc.
- `ai-docs/prompts/folder-split-plan.md`, `ai-docs/prompts/cleanup-plan.md` — kickoff prompts derived from this spec set.
