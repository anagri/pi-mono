# @bodhiapp/bodhi-pi

Embeddable, host-mediated, ACP-speaking coding agent. Sibling to `@mariozechner/pi-coding-agent`. Depends on `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`.

> Status: pre-alpha. Public API and behaviour will change rapidly.

See `ai-docs/research/embeddable-agent-design.md` (architecture) and `ai-docs/research/coding-agent-features.md` (port plan + evolutionary milestones).

## Install

(not yet published)

## Usage

Wire `bodhi-pi` to a host via `@agentclientprotocol/sdk`'s `AgentSideConnection`:

```ts
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import {
	createBodhiPiAgent,
	createInMemoryFilesystem,
	createInMemorySessionStore,
} from "@bodhiapp/bodhi-pi";
import { getModel } from "@mariozechner/pi-ai";

const factory = createBodhiPiAgent({
	models: [getModel("anthropic", "claude-haiku-4-5")],
	defaultModelId: "claude-haiku-4-5",
	getApiKey: (provider) => process.env[`${provider.toUpperCase()}_API_KEY`],
	sessionStore: createInMemorySessionStore(),
	filesystem: createInMemoryFilesystem(),
	systemPrompt: "You are a helpful coding assistant.",
});

new AgentSideConnection(factory, ndJsonStream(process.stdin, process.stdout));
```

`createInMemoryFilesystem()` and `createInMemorySessionStore()` are reference helpers. Production hosts inject Node-fs / OPFS / disk-backed JSONL implementations of the same interfaces. Every host service in `BodhiPiConfig` is **mandatory** — there are no silent default fallbacks (the factory throws if any are missing). The optional `systemPrompt` is config-time only and not persisted as session state; on `session/load` it is reapplied from the current config.

## Test

```bash
# Unit + integration (aimock + faux provider) — no API keys needed
npm test

# e2e against real LLMs — requires e2e/.env.test with API keys
npm run test:e2e
```

Env files:

- `.env` (gitignored) / `.env.example` — runtime env for the package itself.
- `test/.env.test` (gitignored) / `test/.env.test.example` — env for integration tests.
- `e2e/.env.test` (gitignored) / `e2e/.env.test.example` — env for e2e tests (real API keys go here).

## License

MIT
