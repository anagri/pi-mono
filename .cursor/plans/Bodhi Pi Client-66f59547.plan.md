<!-- 66f59547-3034-4347-88b7-860ce99d8172 -->
---
todos:
  - id: "phase-1-core-client"
    content: "Phase 1: implement the client facade in `packages/bodhi-pi` and migrate bodhi-pi tests/e2e helpers from raw ACP setup to the client."
    status: pending
  - id: "phase-1-test"
    content: "Run the relevant `packages/bodhi-pi` tests after Phase 1 and fix failures before continuing."
    status: pending
  - id: "phase-2-cli"
    content: "Phase 2: migrate `packages/bodhi-pi-cli` to use the client for model/auth/session extension operations."
    status: pending
  - id: "phase-2-test"
    content: "Run the relevant `packages/bodhi-pi-cli` tests/checks after Phase 2 and fix failures before continuing."
    status: pending
  - id: "phase-3-web"
    content: "Phase 3: migrate `packages/bodhi-pi-browser`/`packages/bodhi-pi-web` runtime paths to use the client."
    status: pending
  - id: "phase-3-test"
    content: "Run the relevant browser/web package tests after Phase 3 and fix failures before final verification."
    status: pending
  - id: "final-suite"
    content: "Run the complete test suite/checks requested for the finished rollout and fix all remaining failures."
    status: pending
isProject: false
---
# Bodhi Pi TypeScript Client Plan

## Findings

The repeated pattern is raw ACP plumbing leaking into every consumer:

- [packages/bodhi-pi/src/acp/agent.ts](packages/bodhi-pi/src/acp/agent.ts) centralizes `_bodhi-pi/*` dispatch through `extHandlers` and stores provider auth as `auth/<provider>` in `KvStore`.
- [packages/bodhi-pi-cli/src/repl/commands.ts](packages/bodhi-pi-cli/src/repl/commands.ts) manually imports extension constants, builds `auth/<provider>`, calls `extMethod`, parses model `configOptions`, and casts every extension response.
- [packages/bodhi-pi-browser/src/ui/commands.ts](packages/bodhi-pi-browser/src/ui/commands.ts) is a near-port of the CLI command dispatcher, repeating the same auth/session/settings extension calls.
- [packages/bodhi-pi-browser/src/ui/RuntimeProvider.tsx](packages/bodhi-pi-browser/src/ui/RuntimeProvider.tsx) and [packages/bodhi-pi-cli/src/repl/repl.ts](packages/bodhi-pi-cli/src/repl/repl.ts) both have local `modelsFromConfigOptions` helpers that fabricate `Model<Api>` objects with placeholder provider/API data.
- [packages/bodhi-pi/test/helpers/seed-auth.ts](packages/bodhi-pi/test/helpers/seed-auth.ts) documents the desired blackbox e2e flow already: `_bodhi-pi/kv/set auth/<provider>` followed by `setSessionConfigOption("model", modelId)`.
- The Zed research in [ai-docs/research/zed/01-zed-acp-architecture.md](ai-docs/research/zed/01-zed-acp-architecture.md) supports a capability-oriented client facade: Zed wraps wide ACP into local first-class handles for session list, model selection, config options, auth, and updates.

## Proposed Client Shape

Add a new client module inside [packages/bodhi-pi/src/client/](packages/bodhi-pi/src/client/) and export it from [packages/bodhi-pi/src/index.ts](packages/bodhi-pi/src/index.ts). Keep it transport-neutral by wrapping a minimal `BodhiPiAcpConnection` interface satisfied by `ClientSideConnection` today and by `AcpHttpClient` later if needed.

Core API sketch:

```ts
const client = createBodhiPiClient(clientConn, { cwd });
await client.initialize();
await client.newSession();
await client.addProvider("openai", apiKey);
await client.model("gpt-5-mini");
await client.prompt("hello");
```

Public surface:

- ACP first-class methods: `initialize`, `newSession`, `loadSession`, `resumeSession`, `listSessions`, `closeSession`, `prompt`, `cancel`, `setConfigOption`, `model(id?)`, `models()`.
- Bodhi extension methods: `deleteSession`, `compactSession`, `forkSession`, `cloneSession`, `listSessionEntries`, `getSessionTree`, `navigateSession`, `setSessionName`, `getSessionStats`, `exportSession`, `getSessionConfig`.
- Provider auth helpers: `addProvider(provider, apiKey, opts?)`, `removeProvider(provider, opts?)`, `listProviders()`, `getProvider(provider)` implemented over `AUTH_PREFIX` and `_bodhi-pi/kv/*`.
- Settings helpers: `settings.list/get/set/unset` over `_bodhi-pi/session/settings/*`.
- Escape hatch: `acp` or `raw` for the underlying connection and `ext<T>(method, params)` for unsupported extensions.

Use active-session convenience with explicit override support. Methods that need a session use `opts.sessionId ?? client.sessionId`; if neither exists, throw a clear client-side error before making an ACP call. `newSession`, `loadSession`, and `resumeSession` update the active session id.

## Phase 1: `bodhi-pi` Client And Tests

Goal: establish the official client in [packages/bodhi-pi](packages/bodhi-pi), then migrate bodhi-pi tests/e2e setup away from hand-written raw ACP extension calls.

Implementation:

- Add `packages/bodhi-pi/src/client/types.ts` for the minimal connection interface and typed response shapes for current `_bodhi-pi/*` methods. Reuse ACP SDK request/response types and existing exported constants; avoid inventing replacement protocol types.
- Add `packages/bodhi-pi/src/client/config-options.ts` with shared helpers to parse `SessionConfigOption[]` into lightweight model option data, current model id, and config state. This replaces duplicated `modelsFromConfigOptions` helpers without fabricating full `Model<Api>` objects.
- Add `packages/bodhi-pi/src/client/client.ts` with `BodhiPiClient` and `createBodhiPiClient`. Keep methods thin: validate required session id, call ACP or `extMethod`, and normalize response types.
- Export the client from [packages/bodhi-pi/src/index.ts](packages/bodhi-pi/src/index.ts). No new package is needed; the official client should ship with `@bodhiapp/bodhi-pi`.
- Add focused tests in `packages/bodhi-pi/test/client.test.ts` using `createTestHarness`: initialize/new session, `addProvider` masks via `getProvider/listProviders`, `removeProvider`, `model(id)` switches via `MODEL_CONFIG_ID`, active-session errors, and representative session extension helpers.
- Update [packages/bodhi-pi/test/helpers/seed-auth.ts](packages/bodhi-pi/test/helpers/seed-auth.ts) to use the new client: `client.addProvider(provider, key); await client.model(modelId);`.
- Migrate any e2e setup in `packages/bodhi-pi` that currently seeds auth/model state via raw ACP to use the client. Keep tests blackbox; do not reach into agent internals.

Phase test gate:

- From `packages/bodhi-pi`, run `npx tsx ../../node_modules/vitest/dist/cli.js --run test/client.test.ts`.
- Run any existing `packages/bodhi-pi` tests touched by the helper/e2e migration, for example auth, kv, chat, or real e2e setup tests.
- Fix all failures before starting Phase 2.

## Phase 2: `bodhi-pi-cli` Rollout

Goal: make the CLI the first downstream consumer of the official client while preserving its current REPL behavior.

Implementation:

- In [packages/bodhi-pi-cli/src/repl/repl.ts](packages/bodhi-pi-cli/src/repl/repl.ts), create a `BodhiPiClient` after `ClientSideConnection` initialization and use shared config-option parsing for initial model state.
- In [packages/bodhi-pi-cli/src/repl/commands.ts](packages/bodhi-pi-cli/src/repl/commands.ts), put the client in `CommandContext` and replace direct `extMethod`, `setSessionConfigOption`, and provider-auth key construction with client methods.
- Keep rendering, command text, and REPL state behavior stable. This phase is a migration of plumbing, not a UI change.
- Remove local helpers only when the client helper fully replaces them; keep any CLI-specific formatting in CLI code.

Phase test gate:

- Run the `packages/bodhi-pi-cli` package tests if present.
- Run a package-level type/check command for `packages/bodhi-pi-cli` if there is no dedicated test file.
- Fix all failures before starting Phase 3.

## Phase 3: `bodhi-pi-web` Rollout Via Browser Runtime

Goal: migrate the browser runtime used by [packages/bodhi-pi-web](packages/bodhi-pi-web) to the same client, without touching out-of-scope HTTP/WS PoCs.

Implementation:

- In [packages/bodhi-pi-browser/src/ui/RuntimeProvider.tsx](packages/bodhi-pi-browser/src/ui/RuntimeProvider.tsx), create a `BodhiPiClient` around the existing `ClientSideConnection`.
- Replace local `modelsFromConfigOptions` usage with the shared client config-option helper.
- In [packages/bodhi-pi-browser/src/ui/commands.ts](packages/bodhi-pi-browser/src/ui/commands.ts), replace raw extension constants/calls and provider-auth key construction with client methods.
- Keep [packages/bodhi-pi-web/src/App.tsx](packages/bodhi-pi-web/src/App.tsx) mostly unchanged because it delegates to `@bodhiapp/bodhi-pi-browser`.
- Do not migrate [packages/bodhi-pi-http](packages/bodhi-pi-http), [packages/bodhi-pi-ws-frontend](packages/bodhi-pi-ws-frontend), or their custom clients in this rollout.

Phase test gate:

- Run relevant `packages/bodhi-pi-browser` tests after the runtime migration.
- Run relevant `packages/bodhi-pi-web` checks/tests if the app package has them.
- Fix all failures before final verification.

## Design Notes

Prefer `removeProvider(provider)` over `removeProvider(provider, apiKey)`: the server-side remove operation only needs the provider-derived `auth/<provider>` key. If desired, the method can accept an optional second options object, but not an API key.

The client should intentionally remain a facade, not a new transport layer. Zed’s useful lesson is capability wrapping and typed local handles; the transport stays below that boundary.

## Verification

After all phases are complete:

- Run the complete test suite requested for this rollout. Based on current repo rules, use package-specific tests during phases and the full applicable suite at the end, then run `npm run check` from the repo root because this is a cross-package code change.
- If any final test/check fails, fix it before considering the rollout complete.
- Do not run forbidden commands (`npm run dev`, `npm run build`, `npm test`) unless explicitly instructed.