# Kickoff: extract `bodhi-pi-{agent,client}-*` SDK packages from the test-apps

**Output**: an exploratory plan written to `ai-docs/plans/YYYY-MM-DD-bodhi-pi-sdk-extraction.md`. Do your own codebase exploration; batch decision points via `AskUserQuestion` (with your recommended answer per question). Get plan approval before any package scaffolding.

## North star

For the last several PRs we've been preparing the ground so that the four Reference Hosts under `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext}/` could be **extracted into publishable npm packages** without re-architecting them. That groundwork is now done. The remaining work is:

1. Stand up new package directories (or workspaces) for the Agent-side ("Host") and Client-side SDKs across the runtimes we care about.
2. Move (or copy) each Reference Host's `src/host/` into the corresponding `*-agent-*` SDK; each `src/client/` into the corresponding `*-client-*` SDK.
3. Decide how much of `app-utils/` and `node-adapters/` becomes part of the published surface vs internal.
4. Refactor the test-apps to **consume the new SDKs** rather than carry their own implementations — they become the eat-your-own-dogfood reference apps.
5. Set up versioning, publish workflow, and a deprecation path for `packages/bodhi-pi-*` (the previous generation, still in the repo but unmaintained).

**This prompt is exploratory.** The shape of the target packages, what lives in `common` vs the runtime-specific ones, how the test-apps consume them, and the npm scope/name choices are all open. The agent running this prompt is expected to read the code first, ask the user clarifying questions via `AskUserQuestion`, and produce a written plan before any package scaffolding lands.

## Why this is the next step

The user has stated this goal multiple times across the conversation history. The most recent formulation: "we also in future want to publish the agent hosts as sdk BodhiPiHost/BodhiPiServer/BodhiPiAgent etc., so user can quickly build apps for a given runtime, this host,ui separation enables it, with its publishable packages `@bodhiapps/bodhi-pi-agent-{common,node,http,websocket,browser,chrome-ext}` publishing reference host that test-apps and 3rd party apps can use as sdk."

And: "also want to create BodhiPiClient that the ui/frontend/client can reuse consistently, in test-apps and 3rd party apps as sdk `@bodhiapps/bodhi-pi-client-{common,node,http,websocket,browser,chrome-ext}`"

The host/client folder split (commits `65aec3d9..cb14de30`) was the prerequisite. With each test-app's source now cleanly partitioned into `src/{host,client}/...`, extraction becomes copy-and-publish work rather than design work.

## Authority — read first (in this order)

1. `ai-docs/plans/2026-05-17-bodhi-pi-test-apps-host-client-split.md` — the deliverable of the just-completed split. Has the full per-Host outcomes, the app-utils promotions, and the decisions taken.
2. `ai-docs/specs/bodhi-pi/hosts.md` — current per-Host classification tables (HOST vs CLIENT per file, post-split). This is your input inventory.
3. `ai-docs/specs/bodhi-pi/client-sdk-seed.md` — documents `src/client/` in `@bodhiapp/bodhi-pi` core, the seed of `bodhi-pi-client-common`.
4. `ai-docs/specs/bodhi-pi/architecture.md` — the three-roles diagram (Agent/Host/Client) and the dependency injection contract for `BodhiPiConfig`.
5. `ai-docs/specs/bodhi-pi/configuration.md` — the three config layers; relevant because each SDK package needs to expose the right config slice.
6. `packages/bodhi-pi/CONTEXT.md` — locked vocabulary (Host vs Client; UI is a sub-concept inside Client).
7. `packages/bodhi-pi/CLAUDE.md` — operating rules for the core package; many will carry over.

Then walk the actual sources you'll be extracting:
- `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext}/src/{host,client}/...`
- `packages/bodhi-pi/test-apps/{app-utils,node-adapters}/` — shared infra; may or may not stay as separate publishable packages or be folded into `*-common` SDKs.
- `packages/bodhi-pi/src/client/` — the existing `BodhiPiClient` seed.

For comparison / historical context (do **not** copy from these; they're deprecated):
- `packages/bodhi-pi-{cli,web,http,ws-server,ws-frontend,chrome-ext,node,browser}/` — previous-generation packages. They're scheduled for deletion but are not yet deleted. Spec docs flag them as breadcrumbs.

## The shape we're aiming at (user's stated intent — verify and refine)

Two parallel package families. **These names + boundaries are starting hypotheses, NOT locked decisions.** Re-evaluate each during planning.

### Agent-side family (Host runtime SDKs)

| Package (hypothetical) | Contents (hypothesis) | Source |
|---|---|---|
| `bodhi-pi-agent-common` | shared Host bootstrap, adapter interface re-exports, config types | likely composed from `packages/bodhi-pi` re-exports + a thin layer |
| `bodhi-pi-agent-node` | Node adapter set (Filesystem, SessionStore, KvStore, ScriptExecutor, Terminal, extension-loader); used by both cli + http server | `test-apps/node-adapters/` + the shared `host/` pieces of cli + http |
| `bodhi-pi-agent-http` | HTTP+SSE server bootstrap (per-turn rebuild) | `test-apps/http/src/host/` minus the WS-specific files |
| `bodhi-pi-agent-websocket` | WebSocket server bootstrap (long-lived agent) | `test-apps/http/src/host/agent/wire-agent-ws.ts` + WS auth/transport |
| `bodhi-pi-agent-browser` | Browser Worker bootstrap, ZenFS + Dexie adapters, AsyncFunction executor | `test-apps/browser/src/host/` |
| `bodhi-pi-agent-chrome-ext` | MV3 wrapper: sandbox bridge + crypto shim + sandbox iframe page | `test-apps/chrome-ext/src/host/` |

### Client-side family (UI / Transport-Client SDKs)

| Package (hypothetical) | Contents (hypothesis) | Source |
|---|---|---|
| `bodhi-pi-client-common` | `BodhiPiClient` class, shaped types, helpers | `packages/bodhi-pi/src/client/` (already seeded; documented in `client-sdk-seed.md`) |
| `bodhi-pi-client-node` | stdio + in-process transport factories for CLI Clients | `test-apps/cli/src/client/acp/` (REPL/headless wrappers) |
| `bodhi-pi-client-http` | HTTP+SSE TransportAdapter | `test-apps/http/src/client/acp/{adapter-http,acp-http-client,sse-parser}` |
| `bodhi-pi-client-websocket` | WebSocket TransportAdapter | `test-apps/http/src/client/acp/{adapter-ws,ws/*}` |
| `bodhi-pi-client-browser` | MessagePort transport, worker bootstrap helpers, React component shell | `test-apps/browser/src/client/` |
| `bodhi-pi-client-chrome-ext` | chrome runtime messaging + sandbox port factory | `test-apps/chrome-ext/src/client/` |

### Probable npm scope

User mentioned `@bodhiapps/` (with the trailing `s`). The current packages use `@bodhiapp/` (no `s`). **This is a decision the agent must surface.** Recommend: stay on `@bodhiapp/` (matches existing org); the user's "@bodhiapps" mention may have been a typo. But ask before scaffolding 12+ new packages.

## Key questions the planning agent should grapple with

Don't pre-answer these — surface them via `AskUserQuestion`. The recommended answers below are starting points; the user may have different intent.

### Package scope + naming

1. **Scope**: `@bodhiapp/` (existing) vs `@bodhiapps/` (user mentioned). **Recommend**: `@bodhiapp/` for consistency; check with user.
2. **Package count**: 6 agent + 6 client = 12. Could collapse `bodhi-pi-agent-http` + `bodhi-pi-agent-websocket` into one (they share the same server binary today). **Recommend**: keep separate to preserve runtime-specific surface; users who only need HTTP shouldn't pull WS deps. Verify with user.
3. **`-common` packages**: do `bodhi-pi-agent-common` and `bodhi-pi-client-common` actually have content distinct from `@bodhiapp/bodhi-pi` core, or are they thin re-export aliases? **Recommend**: thin re-export aliases initially, with room to grow. Users get `@bodhiapps/bodhi-pi-agent-common` as the "I want the runtime-neutral core" entry point without learning the `@bodhiapp/bodhi-pi` name.

### Shared infrastructure migration

4. **`test-apps/app-utils/`**: it currently holds `transport-types`, `seed-parser`, `message-port-stream`, `worker-message-types`, `pick-defined`, `just-bash-terminal`. After extraction, does this package:
   - (a) stay private and merge its contents into the relevant `bodhi-pi-{agent,client}-{browser,common}` packages, OR
   - (b) become its own published `@bodhiapp/bodhi-pi-test-app-utils` (rename `@bodhiapps/bodhi-pi-shared-utils`?), OR
   - (c) get split: browser-runtime types → client-browser; pickDefined/just-bash → agent-node.
   - **Recommend (c)** — split by consumer. But verify.
5. **`test-apps/node-adapters/`**: similarly, does it stay as a private package or fold into `bodhi-pi-agent-node`? **Recommend**: fold into `bodhi-pi-agent-node`. It's already coupled.

### Test-app future

6. After extraction, do the test-apps:
   - (a) become **consumers** of the published SDKs (real eat-your-own-dogfood; each test-app shrinks to a thin entry-point), OR
   - (b) stay as **standalone reference impls** with the SDKs as a parallel duplicate, OR
   - (c) get **deleted** once the SDKs ship with their own examples?
   - **Recommend (a)** — best test of the SDK boundaries. The test-app's CI then becomes the SDK's CI. Per-Host parity rule (`packages/bodhi-pi/CLAUDE.md` § Runtime-Host parity rule) still applies.

### Public API surface vs internal

7. The `BodhiPiAcpAgent` class is currently a thick façade with 7 services. Which pieces become **public** SDK API and which stay **internal** (re-exported only as opaque types)? **Recommend**: only `createBodhiPiAgent(config)` + the `BodhiPiConfig` type + the adapter interfaces are public. Everything else (`McpService`, `SessionGraphService`, etc.) stays as internal types not re-exported.
8. The `BodhiPiClient` class has ~35 methods. Which are stable v1 surface? **Recommend**: review against `client-sdk-seed.md` — most look stable; mark anything experimental with explicit `unstable_` prefix.

### Versioning + publishing

9. **Coordinated vs independent versions**: today the repo uses `npm version -ws` for coordinated bumps. SDK packages probably want the same coordinated story (any change to `@bodhiapp/bodhi-pi` core forces a re-publish of all `*-agent-*` and `*-client-*` packages, since their behaviour is downstream).
10. **Pre-1.0 vs 1.0**: recommend starting at `0.1.0` for all 12 new packages, with the existing `@bodhiapp/bodhi-pi` core staying at `0.0.x` until the SDK surface stabilises. Decision point for the user.
11. **Publish workflow**: do these go to npm immediately (`npm publish --access public`) or only via the existing `npm run release:patch|minor|major` script? **Recommend** the latter — keep the existing workflow.

### Deprecated `packages/bodhi-pi-*` deletion

12. The old `packages/bodhi-pi-{cli,web,http,ws-server,ws-frontend,chrome-ext,node,browser}/` packages are flagged "not maintained" in many spec docs. Once the new SDKs ship, are they:
    - (a) Deleted from the repo + a final "deprecated" version published with a redirect notice?
    - (b) Left in place forever as historical reference?
    - (c) Renamed (e.g. `_legacy/`) and excluded from `npm run check`?
    - **Recommend (a)** — clean delete + one-line deprecation notice in the README.

### Migration path for existing consumers

13. The pre-existing `packages/bodhi-pi-*` packages have npm `name` fields like `@bodhiapp/bodhi-pi-cli`. If we want the new agent-node package to **own** the `@bodhiapp/bodhi-pi-cli` name on npm (and unblock external users who installed the deprecated one), we need to either:
    - (a) Publish the new `bodhi-pi-agent-node` under a fresh name and leave `@bodhiapp/bodhi-pi-cli` dead, OR
    - (b) Publish the new package as `@bodhiapp/bodhi-pi-cli@next-major`, with the deprecation note in its README.
    - **Recommend (a)** for clarity; the name collision risk of (b) is real.

## Concerns / known traps

1. **chrome-ext consumes browser**: chrome-ext's host/client both import from `@bodhiapp/bodhi-pi-test-app-browser/{host,client}/*`. The extracted `bodhi-pi-agent-chrome-ext` will analogously depend on `bodhi-pi-agent-browser`. Plan for `peerDependencies` or hard deps appropriately.
2. **vite-plugin-node-polyfills**: browser + chrome-ext both depend on this for the `Buffer` polyfill in worker bundles. The published SDK might want to bundle this in or document it as a peer requirement. **Recommend**: document as a peer requirement; including in dist would inflate bundle size.
3. **App-utils' DOM lib**: `seed-parser.ts` uses DOMParser; `message-port-stream.ts` uses MessagePort + WebStreams. If these land in a `bodhi-pi-{agent,client}-browser` package, the tsconfig needs `"lib": ["ES2022", "DOM"]`. The current `app-utils` already has this configured.
4. **cli's `bin` entry**: `test-apps/cli/package.json` has `"bin": {"bodhi-pi-test-app-cli": "./dist/host/cli.js"}`. If we extract to `bodhi-pi-agent-node`, decide whether to publish a `bin` (which makes it a CLI users can `npx`) or just a library. **Recommend**: both library + bin, like coding-agent does.
5. **Server-side dist layout**: http's tsgo strips `rootDir: ./src/host` so output is `dist/index.js` not `dist/host/index.js`. The cli has a different rootDir setup, so its output is `dist/host/cli.js`. Each extracted package needs its tsconfig audited.
6. **e2e helpers and test fixtures**: the `packages/bodhi-pi/e2e/` and `packages/bodhi-pi/e2e-ui/` suites both depend on test-apps as spawned subprocesses (via `dist/index.js` paths in `e2e/global-setup.ts`, `e2e/helpers/cli/harness.ts`, `e2e/cli-headless/*.ts`, and `playwright.config.ts`). If test-apps become consumers of the extracted SDKs, these paths might stay valid (test-apps still build their own `dist/`), but cross-verify before assuming.
7. **The seam-check script**: `scripts/check-host-client-seam.mjs` currently walks `packages/bodhi-pi/test-apps/<host>/src/{host,client}/`. After extraction, each new package's `src/` may or may not have the same `host/client/` split (the AGENT packages won't have `client/`, the CLIENT packages won't have `host/`). The seam check may become a no-op for the extracted packages, but the test-apps (now thin consumers) still need it. Update the script as needed.
8. **CONTEXT.md**: the locked vocabulary (Host = ACP server side of Transport; Client = ACP client side including UI) holds for the SDKs. Reference Host's package README should re-state this in 2 lines so SDK consumers don't have to read CONTEXT.md.

## Plan structure (mandatory sections)

When you write the plan after grilling the user, include:

1. **Goal restatement** — quote the seam definition from CONTEXT.md and the SDK surface intent.
2. **Package matrix** — table of 12 (or however many you propose) new packages. For each: name, scope, contents, dependencies, source location.
3. **Per-package extraction plan** — for each package: which test-app files move (or get copied) into it; whether it's a thin re-export shell or has its own logic; tsconfig + build setup; publish status (private vs public).
4. **app-utils + node-adapters fate** — decision: keep / split / fold; which package each symbol lands in.
5. **Test-app refactor** — after extraction, what each test-app looks like (entry-point only, importing from the SDK). Specifically how `e2e/`+`e2e-ui/` spawn paths are preserved.
6. **Versioning + publish strategy** — coordinated vs independent versions, initial version number, publish workflow.
7. **Deprecation path for `packages/bodhi-pi-*`** — keep / delete / archive; npm deprecation messages if needed.
8. **Per-commit slice** — bounded commits. Likely many (10+) since this touches a lot of files. Group by package family or by Host runtime to keep commits reviewable.
9. **Risk register** — call out chrome-ext-depends-on-browser, vite-plugin-node-polyfills peer dep, e2e fixture path stability, seam-check script update, naming collision with deprecated packages, BodhiPiAcpAgent internal-vs-public boundary.
10. **Verification matrix** — every commit gates against the same matrix used for the host/client split: `npm run check` (incl. seam-check) + `npm test -w @bodhiapp/bodhi-pi` (50/399) + `npm run test:e2e -w @bodhiapp/bodhi-pi` (211/222) + `cd packages/bodhi-pi/e2e-ui && npm test` (46/48). After test-apps become SDK consumers, also verify spawn paths in `e2e/global-setup.ts` still resolve.
11. **Out of scope** — explicitly: actual npm publish (gated behind user approval); deletion of deprecated `packages/bodhi-pi-*` (separate cleanup PR); design-smell refactors (D1-D10 from `ai-docs/plans/2026-05-17-bodhi-pi-design-smell-followup.md`); SDK README/docs writing beyond the per-package one-pager.

## Working style

- This is exploratory. Read code FIRST (especially the per-Host `src/host/` and `src/client/` trees, and `app-utils/`), then form questions, then batch them via `AskUserQuestion` (with your recommended answer per question, marked "(Recommended)").
- When you discover something surprising (e.g. an import you didn't expect, a config quirk that makes extraction harder than the layout suggests), surface it.
- Use `Plan` agent for design questions you can't resolve from the user alone.
- Get the user's approval on the WRITTEN PLAN before any package scaffolding, file moves, or new directories.
- **Do not pause during the planning phase for approval**; ask questions to reach a complete plan, then propose the plan via `ExitPlanMode`.

## When done

Print: the plan path, the proposed package count, and the recommended commit count. Do NOT scaffold any new packages or move any files in this round — the plan IS the deliverable. Code/folder moves happen in a separate session, ideally guided by `superpowers:executing-plans`.

## See also

- `ai-docs/plans/2026-05-17-bodhi-pi-test-apps-host-client-split.md` — the deliverable that unblocked this work; per-Host outcomes table is your starting inventory.
- `ai-docs/specs/bodhi-pi/client-sdk-seed.md` — `BodhiPiClient` documentation, current consumers, future-SDK extraction roadmap (intent-only section that this prompt operationalises).
- `ai-docs/plans/2026-05-17-bodhi-pi-design-smell-followup.md` — D12 (shared Host bootstrap template) folds naturally into `bodhi-pi-agent-common`; D1-D11 are out of scope for the extraction but worth being aware of.
- `packages/bodhi-pi/CLAUDE.md` § Runtime-Host parity rule — every user-visible feature must land in all four Reference Hosts; this rule applies to the extracted SDKs too (a feature added to `bodhi-pi-agent-node` should have a `bodhi-pi-agent-browser` equivalent).
- `packages/bodhi-pi/CLAUDE.md` § pi-agent-core import policy — `Agent` is imported via deep import from `dist/agent.js`. Each extracted `bodhi-pi-agent-*` SDK may need to follow the same discipline; check.
