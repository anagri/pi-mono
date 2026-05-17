# MCP — spec/implementation gaps

Audit of `ai-docs/specs/bodhi-pi/{mcp.md, acp.md, hosts.md, architecture.md, index.md, extensions-skills-commands.md}` against the MCP implementation in `packages/bodhi-pi/src/mcp/` and the Reference Hosts under `test-apps/`, covering commits `b180f61b..HEAD` (the MCP-OAuth re-introduction through `04fef519` mcp-auth review fixes).

Most spec drift surfaced here has been corrected in the same change that landed this file — see the companion commit for the inline updates. This document keeps two things:

1. A historical record of what was wrong (so future audits can spot regressions).
2. Open items that are **intentional capability gaps** (`§ Intentional gaps` below), which the spec now calls out but does not "fix".

## Resolved spec drift (corrected in the same commit)

| Where | Was | Now |
|---|---|---|
| `index.md:24` | Claimed `_bodhi-pi/mcp/oauth/*` and `KvOAuthProvider` were removed; only `auth.mode = "public"` supported. | Rewritten to state the four-input-mode re-introduction; OAuth, PKCE, RFC 7591 DCR, RFC 8414/9728 discovery all wired. |
| `hosts.md:12` (at-a-glance matrix) | http row `MCP stdio? = yes (server-side)`. | `no (supportsMcpStdio:false)` with rationale (per-turn rebuild can't own a long-lived stdio child). |
| `mcp.md` decomposition diagram | Omitted `mcp-stdio-env.ts`. | Listed alongside the OAuth sub-modules. |
| `mcp.md` Auth intro | "Three modes supported; `oauth-dcr` tracked separately under `ai-docs/prompts/…`". | "Four input modes accepted; collapse into three persisted modes via `AUTH_INPUT_RESOLVERS`." |
| `mcp.md` Validation bullet | "auth must be `public`, `http-param`, or `oauth-preregistered`". | Includes `oauth-dcr` and a dedicated `oauth-dcr` requirements row. |
| `mcp.md` OAuth flow section | Three methods only (`start`/`finish`/`cancel`). | Five methods — added `oauth/discover` (RFC 9728+8414) and `oauth/register` (RFC 7591). |
| `mcp.md` Transport gating | Brief paragraph on stdio gating only. | Three subsections: (a) HTTP = Streamable HTTP only, deprecated SSE intentionally not wired; (b) per-Host stdio matrix with rationale; (c) stdio = `public`-auth-only, env vars are the sole credential channel. |
| `mcp.md` Tests | Did not list OAuth test files. | Lists `mcp-oauth*.test.ts` and the cli-headless / e2e-ui OAuth specs; flags the DCR Playwright gap (§D below). |
| `acp.md:90` (`oauth/start` row) | Error condition "or not oauth-preregistered". | "persisted `auth.mode !== "oauth"`" (matches the actual check at `mcp-service.ts:259`). |
| `architecture.md:67` (McpService method list) | Listed `_bodhi-pi/mcp/{add,remove,connect,disconnect,reconnect,list,tools,include,exclude}` only. | Adds `oauth/{start,finish,cancel,discover,register}` and the DCR add-flow. |
| `architecture.md` `src/mcp/` layout block | Omitted `KvOAuthProvider`, `OAuthStateKv`, `oauth-state-token`, `mcp-stdio-env`. | All four called out. |
| `extensions-skills-commands.md:112` | "reached via HTTP-Streamable or stdio" (no caveat). | Adds the CLI-only stdio caveat and the Streamable-HTTP-only / no-SSE caveat. |

## Intentional capability gaps (now documented in the spec)

### A. stdio MCP transport is CLI-only

| Host | `supportsMcpStdio` | Source |
|---|---|---|
| cli | default `true` | (no explicit set; agent default — `src/acp/agent.ts:239`) |
| http | `false` | `test-apps/http/src/host/agent/wire-agent-shared.ts:121` |
| browser | `false` | `test-apps/browser/src/host/runtime/bootstrap-worker.ts:218` |
| chrome-ext | `false` | inherits browser's `bootstrapAgentWorker` (chrome-ext reuses browser host) |

Rationale per Host:
- **browser / chrome-ext** — no `child_process`; Web Worker / MV3 service worker can't spawn.
- **http** — stateless per-turn agent rebuild; a long-lived stdio child can't be cleanly owned by an agent that dies between requests, and the multi-tenant model has no clean isolation story for spawned children.

### B. stdio MCP has no authentication channel — only env vars

`resolveAuthInput` (`mcp-service.ts:610-614`) short-circuits when `transport === "stdio"`: any non-`public` `auth` value or sibling `headers` / `queries` rejects with `-32602`. The persisted `auth` is always `{ mode: "public" }` for stdio entries.

Practical consequence:
- **No bearer / API-key / OAuth for stdio MCP servers.** Credentials reach the child process only via the `env` vector on `/mcp add` (`McpNamedSecret[]`, masked to `***` on ACP reads but plaintext when spawning).
- An MCP server that requires HTTP-style headers, query-string auth, or OAuth must be reached through the http transport.

By design: stdio MCP servers are local children of the agent process, and the security model is "trust the process you spawned" rather than per-request credential injection.

### C. Deprecated MCP SSE transport is intentionally NOT implemented

`src/mcp/mcp-client.ts:2` imports only `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`. The legacy SSE-only transport (`@modelcontextprotocol/sdk/client/sse.js`) is not imported anywhere in `src/`. `initialize` advertises this via `agentCapabilities.mcpCapabilities = { http: true, sse: false }` (`src/acp/agent.ts:344`).

Rationale: the MCP spec deprecated standalone SSE in favour of Streamable HTTP. MCP servers that only support the legacy SSE path are unsupported.

### D. DCR cross-runtime e2e coverage gap

| Variant | cli-headless e2e | Playwright e2e-ui (browser/http/ws/chrome-ext) |
|---|---|---|
| `auth: "public"` | yes (`mcp.e2e.ts`) | yes (`mcp-public-http.spec.ts`, `mcp-multi.spec.ts`) |
| `auth: "http-param"` | yes (`mcp-auth.e2e.ts`) | yes (`mcp-auth.spec.ts`) |
| `auth: "oauth-preregistered"` | yes (`mcp-oauth.e2e.ts`) | yes (`mcp-oauth.spec.ts`) — green across all 4 runtimes per commit `fabd6878` |
| `auth: "oauth-dcr"` | yes (`mcp-oauth-dcr.e2e.ts`) | **no `e2e-ui/shared/mcp-oauth-dcr.spec.ts`** |
| `transport: "stdio"` | yes (`mcp-stdio.e2e.ts`) | n/a (only CLI supports stdio — §A) |

Per the runtime-Host parity rule in `CLAUDE.md`, DCR-via-Playwright is a parity hole. Either:
- Add a Playwright spec mirroring `mcp-oauth.spec.ts` (DCR runs server-side in `runDcrAddFlow` so the runtime-specific work is minimal — the `/mcp add` slash parser already accepts `{auth:"oauth-dcr"}`), OR
- Document the deferral with a rationale and a follow-up task reference.

This is the only remaining "open" gap from the audit; everything else is either resolved (§ Resolved spec drift) or intentionally so (§A-C).
