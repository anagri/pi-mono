# Plan — Milestone M1.3: Switch Model via ACP Session Config

## Context

M1.2 made bodhi-pi speak ACP. The factory currently takes a single `model: Model<Api>` and hard-codes it for the lifetime of every session. M1.3 lifts that limit: the host advertises a registry of models in `BodhiPiConfig`, the agent surfaces them as a session-level config option named `"model"`, and the host switches the active model mid-session via the **stable** `session/setSessionConfigOption` ACP method. The next prompt in that session routes to the new model.

This is the right ACP-shaped mechanism for M1.3:
- **`session/setSessionConfigOption`** is stable, generic, and is the protocol's preferred pattern for any session-scoped selector (cited in `docs/protocol/session-config-options.mdx`).
- **`unstable_setSessionModel`** exists in the SDK but is experimental and gated by `#[cfg(feature = "unstable_session_model")]` in the Rust source — explicitly out of scope.
- One-model-per-session (no in-session switching) is too narrow for the milestone's intent.

Functionality borrowed verbatim from coding-agent's structure: `models: Model<Api>[]` flat array, mutate `agent.state.model` on switch (pi-agent-core's `streamSimple` reads it per turn, so the next prompt picks up the new model automatically — confirmed at `packages/coding-agent/src/core/agent-session.ts:1417-1428` and `packages/agent/src/agent.ts:194`).

---

## Decisions (confirmed)

- **Mechanism:** stable `session/setSessionConfigOption` with `configId: "model"`, `category: "model"`, `type: "select"`. No `unstable_setSessionModel`.
- **Registry shape:** match coding-agent — a flat `Model<Api>[]` array stored in `BodhiPiConfig`. Each entry's own `id` / `name` fields drive the ACP option list (no extra naming layer).
- **Default model:** `BodhiPiConfig.defaultModelId: string` — must be one of `models[i].id`; validated at factory construction.
- **Notification on client-driven change:** none. The `setSessionConfigOption` response IS the update (it returns the full `configOptions` array per spec). `session/update`-with-`config_option_update` is reserved for agent-driven changes (e.g., rate-limit fallback) — out of scope for M1.3.
- **Tests:** rename `simple_chat.{test,e2e}.ts` → `chat.{test,e2e}.ts`. Adapt the existing single-model assertions to the new registry shape and add multi-model switching assertions in the same files (one cohesive theme).
- **Auth resolution:** unchanged — `BodhiPiConfig.getApiKey: (provider) => string | undefined` already handles per-provider keys; pi-agent-core calls it per turn keyed by the active model's `provider`.

---

## Architecture delta from M1.2

```
BodhiPiConfig {
-   model: Model<Api>
+   models: Model<Api>[]
+   defaultModelId: string
    getApiKey: (provider) => string | undefined
}

BodhiPiAcpAgent {
    private sessions = new Map<sessionId, {
        piAgent: PiAgent,
+       currentModelId: string,
    }>()

    initialize     // unchanged
    authenticate   // unchanged
    newSession     // returns configOptions[] with model selector
+   setSessionConfigOption  // implements model swap
    prompt         // unchanged (pi-agent reads state.model per turn)
    cancel         // unchanged
}
```

`session/new` now returns:

```ts
{
  sessionId,
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: defaultModelId,
      options: models.map(m => ({ value: m.id, name: m.name, description: undefined })),
    }
  ]
}
```

`session/setSessionConfigOption({ sessionId, configId: "model", value: newId })`:
- 404 (`RequestError`) if `configId !== "model"` or `value` is not in `models[].id`.
- Look up new model, mutate the per-session pi-agent's `state.model = newModel`, update `currentModelId`.
- Return `{ configOptions: [...full state...] }`.

---

## Files

### Modified

- `packages/bodhi-pi/package.json` — no change.
- `packages/bodhi-pi/src/acp/agent.ts` — registry-aware factory, per-session model tracking, `setSessionConfigOption` handler, `buildModelConfigOption()` helper.
- `packages/bodhi-pi/src/index.ts` — re-export updated `BodhiPiConfig` (no other changes).
- `packages/bodhi-pi/src/core/agent-session.ts` — unchanged (still the per-session pi-agent factory).
- `packages/bodhi-pi/CHANGELOG.md` — add M1.3 entry.

### Renamed + extended

- `packages/bodhi-pi/test/simple_chat.test.ts` → `packages/bodhi-pi/test/chat.test.ts`
- `packages/bodhi-pi/e2e/simple_chat.e2e.ts` → `packages/bodhi-pi/e2e/chat.e2e.ts`

Both files keep their existing single-model assertions (adapted to the new registry shape — wrap the one model in `models: [...]`, set `defaultModelId`) and add a switching test in the same file.

### Untouched

- `packages/bodhi-pi/test/helpers/in-process-connection.ts` — same wiring.
- All vitest configs, tsconfigs, env files, biome config, root tsconfig.
- `packages/bodhi-pi/src/index.ts` exports list (only the inner `BodhiPiConfig` shape changes; the export name doesn't).

---

## `src/acp/agent.ts` shape after M1.3

```ts
import type {
    Agent as AcpAgent,
    AgentSideConnection,
    AuthenticateRequest, AuthenticateResponse,
    CancelNotification,
    InitializeRequest, InitializeResponse,
    NewSessionRequest, NewSessionResponse,
    PromptRequest, PromptResponse,
    SessionConfigOption,
    SessionNotification,
    SetSessionConfigOptionRequest, SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { Agent as PiAgent } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createAgentSession } from "../core/agent-session.js";

const MODEL_CONFIG_ID = "model";

export interface BodhiPiConfig {
    /** Models the host wants to expose. Each entry's id/name drives the ACP option list. */
    models: Model<Api>[];
    /** id of the default model — must be one of models[i].id. */
    defaultModelId: string;
    /** Resolves API key per provider name (e.g., "anthropic", "openai"). */
    getApiKey: (provider: string) => string | undefined;
}

interface SessionState {
    piAgent: PiAgent;
    currentModelId: string;
}

export function createBodhiPiAgent(config: BodhiPiConfig) {
    if (!config.models.find((m) => m.id === config.defaultModelId)) {
        throw new Error(`defaultModelId "${config.defaultModelId}" not in models registry`);
    }
    return (conn: AgentSideConnection): AcpAgent => new BodhiPiAcpAgent(config, conn);
}

class BodhiPiAcpAgent implements AcpAgent {
    private sessions = new Map<string, SessionState>();
    private nextId = 0;

    constructor(
        private readonly config: BodhiPiConfig,
        private readonly conn: AgentSideConnection,
    ) {}

    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        return {
            protocolVersion: 1,
            agentCapabilities: {
                loadSession: false,
                promptCapabilities: { image: false, audio: false, embeddedContext: false },
                mcpCapabilities: { http: false, sse: false },
            },
            authMethods: [],
        };
    }

    async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
        return {};
    }

    async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
        const sessionId = `bodhi_${++this.nextId}`;
        const defaultModel = this.findModel(this.config.defaultModelId);
        const piAgent = createAgentSession({
            initialState: { model: defaultModel },
            getApiKey: this.config.getApiKey,
        });
        this.sessions.set(sessionId, { piAgent, currentModelId: this.config.defaultModelId });
        return {
            sessionId,
            configOptions: [this.buildModelConfigOption(this.config.defaultModelId)],
        };
    }

    async setSessionConfigOption(
        params: SetSessionConfigOptionRequest,
    ): Promise<SetSessionConfigOptionResponse> {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new RequestError(-32602, `unknown session: ${params.sessionId}`);
        }
        if (params.configId !== MODEL_CONFIG_ID) {
            throw new RequestError(-32602, `unknown configId: ${params.configId}`);
        }
        if (typeof params.value !== "string") {
            throw new RequestError(-32602, `model config requires string value, got ${typeof params.value}`);
        }
        const newModel = this.findModel(params.value);
        // Mutate the pi-agent's active model. pi-ai's streamSimple reads
        // state.model per turn, so the next prompt routes here.
        session.piAgent.state.model = newModel;
        session.currentModelId = params.value;
        return {
            configOptions: [this.buildModelConfigOption(params.value)],
        };
    }

    async prompt(params: PromptRequest): Promise<PromptResponse> {
        const session = this.sessions.get(params.sessionId);
        if (!session) throw new Error(`unknown session: ${params.sessionId}`);

        const text = params.prompt
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("");

        const unsubscribe = session.piAgent.subscribe(async (event) => {
            if (event.type !== "message_update") return;
            const sub = event.assistantMessageEvent;
            if (sub.type !== "text_delta") return;
            const update: SessionNotification = {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: sub.delta },
                },
            };
            await this.conn.sessionUpdate(update);
        });

        try {
            await session.piAgent.prompt(text);
            await session.piAgent.waitForIdle();
            return { stopReason: "end_turn" };
        } finally {
            unsubscribe();
        }
    }

    async cancel(params: CancelNotification): Promise<void> {
        this.sessions.get(params.sessionId)?.piAgent.abort();
    }

    private findModel(id: string): Model<Api> {
        const m = this.config.models.find((x) => x.id === id);
        if (!m) throw new RequestError(-32602, `unknown model id: ${id}`);
        return m;
    }

    private buildModelConfigOption(currentValue: string): SessionConfigOption {
        return {
            id: MODEL_CONFIG_ID,
            name: "Model",
            category: "model",
            type: "select",
            currentValue,
            options: this.config.models.map((m) => ({
                value: m.id,
                name: m.name,
            })),
        };
    }
}
```

References to existing surfaces being reused:
- coding-agent pattern (`packages/coding-agent/src/core/agent-session.ts:1416-1428`) — `setModel` mutates `agent.state.model` then proceeds.
- pi-agent-core `Agent` (`packages/agent/src/agent.ts:194` — defaults `streamFn` to `streamSimple`; `:283-298` — `signal` / `waitForIdle`; `:312-323` — `prompt`).
- ACP types (`/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts`):
  - `SessionConfigOption` (line 3967): `{id, name, category?, type: "select"|"boolean", currentValue, options}`.
  - `SessionConfigSelectOption` (line 4054): `{value, name, description?}`.
  - `SetSessionConfigOptionRequest` (line 4420): `{sessionId, configId, value: SessionConfigValueId | boolean}`.
  - `SetSessionConfigOptionResponse` (line 4454): `{configOptions: SessionConfigOption[]}`.
  - `NewSessionResponse.configOptions` (line 3115): optional `SessionConfigOption[]`.
- ACP docs: `docs/protocol/session-config-options.mdx`.

---

## `test/chat.test.ts` (renamed + extended; integration via aimock)

Two tests in one file. Both use `createInProcessAcpPair` from M1.2.

### Test 1 — "simple chat round-trips via ACP through aimock" (carry-over from simple_chat)

- Single model in registry: `[gpt-5-mini-stub]` with baseUrl pointing at one `LLMock`.
- aimock: `mock.onMessage(/Monday/i, { content: "tuesday" })`.
- Flow: `initialize → newSession → prompt("Answer in one word: what day comes after Monday?")`.
- Asserts:
  - `result.stopReason === "end_turn"`.
  - `newSessionResponse.configOptions[0]` matches `{ id: "model", currentValue: "gpt-5-mini" }` plus 1-element `options` array.
  - Concatenated `agent_message_chunk` text equals `"tuesday"`.

### Test 2 — "switch model via setSessionConfigOption routes to second mock"

- Two `LLMock` instances on free ports (`port: 0`) to avoid contention.
- `mockA.onMessage(/.*/, { content: "from-a" })`.
- `mockB.onMessage(/.*/, { content: "from-b" })`.
- Registry: `[modelA(baseUrl=mockA.url), modelB(baseUrl=mockB.url)]`, `defaultModelId: "modelA-id"`.
- Flow:
  - `initialize → newSession`.
  - `prompt("any")` → assert chunked text === `"from-a"`.
  - `setSessionConfigOption({ configId: "model", value: "modelB-id" })` → assert response `configOptions[0].currentValue === "modelB-id"`.
  - `prompt("any")` → assert chunked text === `"from-b"`.
- Both `LLMock` instances stopped in `afterEach`.

---

## `e2e/chat.e2e.ts` (renamed + extended; real LLMs)

Three tests. The first two are the carry-overs (Anthropic + OpenAI baseline); the third is the new switching scenario.

### Test 1 — "Anthropic Haiku replies with tuesday via ACP"

- Registry: `[claude-haiku-4-5]`, default = its id.
- Same prompt + assertions as M1.2.

### Test 2 — "OpenAI gpt-5-mini replies with tuesday via ACP"

- Registry: `[gpt-5-mini]`, default = its id.
- Same prompt + assertions as M1.2.

### Test 3 — "switching model mid-session changes provenance"

- Registry: `[claude-haiku-4-5, gpt-5-mini]`, default = `"claude-haiku-4-5"`.
- Both API keys required (loud failure if either missing).
- Flow:
  - `initialize → newSession` → assert `currentValue === "claude-haiku-4-5"`.
  - `prompt("In one word, name the company that trained you.")` → assert response (concatenated chunks) **case-insensitively contains** `"anthropic"` OR `"claude"`.
  - `setSessionConfigOption({ configId: "model", value: "gpt-5-mini" })` → assert response `currentValue === "gpt-5-mini"`.
  - `prompt("In one word, name the company that trained you.")` → assert response **case-insensitively contains** `"openai"` OR `"gpt"`.
  - Reads `getApiKey` per turn keyed by the *current* model's provider, so the second turn must hit OpenAI.

Both prompts are deliberately structured for stable model-self-identification answers; assertions allow either of two acceptable substrings to absorb minor prose variation.

---

## CHANGELOG entry

```
## [Unreleased]

### Added
- M1.3 — Per-session model switching over ACP. BodhiPiConfig now takes
  `models: Model<Api>[]` plus `defaultModelId: string`. `session/new` advertises
  the available models as a SessionConfigOption named `"model"`; the host can
  switch via the stable `session/setSessionConfigOption` method. The next prompt
  routes to the new model automatically (pi-agent-core reads `state.model` per
  turn).
```

---

## Implementation steps

1. **Rewrite `src/acp/agent.ts`** with the registry shape, per-session `currentModelId`, and `setSessionConfigOption` handler.
2. **Rename `test/simple_chat.test.ts` → `test/chat.test.ts`**; adapt existing test to registry shape; add switching test using two `LLMock` instances.
3. **Rename `e2e/simple_chat.e2e.ts` → `e2e/chat.e2e.ts`**; adapt existing two tests to registry shape; add the third "switching mid-session" test.
4. Run gate-checks (see Verification).
5. Update `CHANGELOG.md`.
6. Commit: `feat(bodhi-pi): land M1.3 — switch model via session/setSessionConfigOption`.

---

## Verification

From repo root:

```bash
# Lint + typecheck across the monorepo
npm run check

# Build bodhi-pi
npm --workspace @bodhiapp/bodhi-pi run build

# Offline (unit + integration via aimock + ACP)
npm --workspace @bodhiapp/bodhi-pi run test

# Online (real LLMs via ACP)
npm --workspace @bodhiapp/bodhi-pi run test:e2e
```

Expected:
- `npm run check` — clean.
- `build` — emits `dist/index.{js,d.ts}`, `dist/core/agent-session.{js,d.ts}`, `dist/acp/agent.{js,d.ts}` plus maps.
- `test` — 2 integration tests pass (single-model baseline + multi-model switching).
- `test:e2e` — 3 e2e tests pass (Anthropic baseline + OpenAI baseline + switching mid-session).

Acceptance gate: an ACP-aware host can drive bodhi-pi through `initialize → newSession → prompt(model A) → setSessionConfigOption(model B) → prompt(routes to B)` and observe both `agent_message_chunk` streams arriving from the two distinct backends.

---

## Out of scope for M1.3 (and where each lands)

| Concern                                              | Lands in     |
| ---------------------------------------------------- | ------------ |
| Model cycling shortcut / `cycle_model`               | host concern (UX) — not the agent's job |
| Custom-model registry from `~/.bodhi-pi/models.json` | Phase 7 (resource-loader) |
| `enabledModels` / scoped models setting              | Phase 7 (resource-loader / settings) |
| Auth pre-flight check before switching               | Phase 8 (permissions) — for now we just trust `getApiKey` |
| `unstable_setSessionModel` adapter                   | declined; not implementing experimental APIs |
| Agent-driven `config_option_update` notification     | when fallback / rate-limit logic arrives (later phase) |
| Per-session thinking-level config option             | future M1.x — same `setSessionConfigOption` mechanism |
| `enabledModels`-style glob patterns                  | host concern (registry construction time) |
| Sessions persistence / fork / clone                  | M2.x         |
| Filesystem / Terminal / tools                        | M3.x – M4.x  |

---

## Critical files referenced

- `packages/coding-agent/src/core/agent-session.ts:1404` — `model_select` event payload (we don't emit one, but the field shape `{model, previousModel, source}` could inform future custom `_meta` payload).
- `packages/coding-agent/src/core/agent-session.ts:1416-1428` — `setModel` flow that mutates `agent.state.model` directly; pattern we follow.
- `packages/coding-agent/src/core/model-registry.ts:330-349` — `ModelRegistry` shape (`models: Model<Api>[]`); we mirror the array choice.
- `packages/agent/src/agent.ts:194` — pi-agent-core defaults `streamFn` to `streamSimple`, which reads `state.model` per turn — the basis for "next prompt picks up the new model automatically."
- `/tmp/acp-sdk-inspect/package/dist/acp.d.ts:967` — `Agent.setSessionConfigOption?` interface method we implement.
- `/tmp/acp-sdk-inspect/package/dist/acp.d.ts:376` — `ClientSideConnection.setSessionConfigOption(params)` — what tests call.
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:3967` — `SessionConfigOption` discriminated union with `type: "select" | "boolean"`.
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:4420` — `SetSessionConfigOptionRequest` exact shape.
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:4454` — `SetSessionConfigOptionResponse` returns full `configOptions`.
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:3099` — `NewSessionResponse.configOptions` (optional) — where we inject the model selector at session creation.
- `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/docs/protocol/session-config-options.mdx` — protocol's normative doc for this mechanism.

---

## After approval

After M1.3 lands, save these durable preferences to memory (project-feedback type):
- bodhi-pi reaches for **stable** ACP methods; experimental/`unstable_*` methods only when no stable path exists.
- Model selection is exposed as a `SessionConfigOption` (`id: "model"`, `category: "model"`), not as `unstable_setSessionModel`.
- Mutating `pi-agent-core`'s `agent.state.model` between prompts is the canonical bridge for in-session model swap (no Agent reconstruction, no replaying messages).
- Test files named thematically: `chat.{test,e2e}.ts` covers single-model AND multi-model scenarios as one cohesive theme.
