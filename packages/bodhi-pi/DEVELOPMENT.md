# bodhi-pi — Development Guide

## Toolchain

- **Node:** 24.15.0 (Active LTS). Pinned via root `.tool-versions` / `.nvmrc`. Published `engines`: `>=20.0.0`.
- **Build:** `tsgo` (`@typescript/native-preview` at root). No bundler; `tsc`-equivalent emit only.
- **Lint/format:** `biome` (tabs, width 3, line 120). `npm run check` at root.
- **Pre-commit:** root `npm run check` (biome + tsgo --noEmit + browser smoke).
- **Commits:** `feat(bodhi-pi):` / `fix` / `refactor` / `test` / `docs`. npm workspaces, semver pins (not `workspace:*`).

## Commands

```bash
npm run check                                      # lint + typecheck (monorepo)
npm --workspace @bodhiapp/bodhi-pi run build       # build this package
npm --workspace @bodhiapp/bodhi-pi run test        # unit + integration (offline)
npm --workspace @bodhiapp/bodhi-pi run test:e2e    # e2e against real LLMs
```

## ENV files (all gitignored)

| File | Purpose |
|---|---|
| `test/.env.test` | Integration — no real keys needed |
| `e2e/.env.test` | `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` for e2e |

## Test architecture

| Layer | Config | Files | LLM |
|---|---|---|---|
| Unit | `vitest.config.ts` | `src/**/*.test.ts` | none |
| Integration | `vitest.config.ts` | `test/**/*.test.ts` | stub (aimock / faux) |
| e2e | `vitest.e2e.config.ts` | `e2e/**/*.e2e.ts` | real |

`vitest.config.ts` source-aliases `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` to workspace `src/index.ts`.

`vitest.e2e.config.ts` does **NOT** use `mergeConfig` — vitest's array-merge for `test.include` is unstable. Composes explicitly.

Transport: in-process paired `TransformStream`s (`test/helpers/in-process-connection.ts`).

### Test helper catalog (`test/helpers/`)

| File | Exports |
|---|---|
| `harness.ts` | `createTestHarness({ models, defaultModelId, getApiKey?, sessionStore?, filesystem?, scriptExecutor?, systemPrompt? })` → `{ clientConn, updates, filesystem, sessionStore }` |
| `in-process-connection.ts` | `createInProcessAcpPair()` |
| `notifications.ts` | `chunkedAgentText`, `userChunkText` |
| `acp-constants.ts` | `stdInitParams` |
| `env.ts` | `requireEnv(name)` — loud-fail on missing key |
| `acp-narrow.ts` | `asSelectOption`, `SelectOption` |
| `tool-call-asserts.ts` | `toolCallStarts`, `toolCallUpdates`, `toolUpdateText` |
| `faux-script.ts` | `scriptToolThenDone(faux, name, args)` |

### Stub strategy

| Scenario | Use |
|---|---|
| Text-only turns | `aimock` (`@copilotkit/aimock`) — one instance per test, `port: 0` |
| Tool-call turns | `registerFauxProvider` from `pi-ai/providers/faux` — aimock SSE isn't always parsed for tool-call rounds |

### e2e / testing new features

Plan integration and e2e at design time, not after.

- Per-feature e2e: `gpt-4o-mini` (non-reasoning; avoids pi-ai `openai-responses` reasoning-item 404). Cross-provider parity lives in `e2e/chat.e2e.ts`.
- See `test/chat.test.ts`, `test/fs.test.ts`, `e2e/chat.e2e.ts`, `e2e/fs.e2e.ts` for canonical patterns.
- Prompts: forced-choice phrasing, side-effect assertions, stable-substring `contains`. Never assert exact model text.

## Comments policy

No comments by default. Add one only when the **why** is non-obvious to a reader with the code in front of them:

- Hidden constraint, subtle invariant, cross-module coupling, or a protocol/wire rule not visible locally
- Don't restate types, narrate the next line, or reference the current task / issue / PR

Examples worth keeping: why mutating `session.piAgent.state.model` re-routes the next turn; why `cancelled` is reset at the start of every `prompt`; why `closeSession` keeps the persisted record; ACP spec citations that pin a behaviour to an external contract.

One sentence beats five. If a paragraph feels needed, the code probably needs splitting or renaming instead. Tests don't need comments — `it("rejects unknown sessionId")` is its own documentation.

## External references

| Path | Role |
|---|---|
| `packages/coding-agent/` | Canonical reference — read before porting any feature |
| `.../agentclientprotocol/agent-client-protocol/docs/protocol/` | Normative ACP spec |
| `/tmp/acp-sdk-inspect/package/dist/acp.d.ts` | ACP TS SDK interfaces |

> Recreate `/tmp/acp-sdk-inspect/` if missing:
> ```bash
> mkdir -p /tmp/acp-sdk-inspect && cd /tmp/acp-sdk-inspect && \
>   curl -fsSL "$(npm view @agentclientprotocol/sdk dist.tarball)" -o sdk.tgz && tar -xzf sdk.tgz
> ```
