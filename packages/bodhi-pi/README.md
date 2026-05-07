# @bodhiapp/bodhi-pi

Embeddable, host-mediated, ACP-speaking coding agent. Sibling to `@mariozechner/pi-coding-agent`. Depends on `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`.

> Status: pre-alpha. Public API and behaviour will change rapidly.

See `ai-docs/research/embeddable-agent-design.md` (architecture) and `ai-docs/research/coding-agent-features.md` (port plan + evolutionary milestones).

## Install

(not yet published)

## Test

```bash
# Unit + integration (aimock) — no API keys needed
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
