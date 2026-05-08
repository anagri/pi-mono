# bodhi-pi-cli

Interactive REPL CLI for live-testing `@bodhiapp/bodhi-pi` against a real working tree and a real LLM.

## Setup

```sh
cp .env.example .env
# Fill in at least one API key
npm run build
```

## Usage

```sh
node dist/cli.js [options]
# or after linking: bodhi-pi-cli [options]
```

### Options

| Flag | Description |
|---|---|
| `--model <id>` | Model to use (default: first model with a key) |
| `--system-prompt <text>` | System prompt |
| `--system-prompt-file <path>` | Read system prompt from file |
| `--db <path>` | SQLite DB path (default: `~/.bodhi-pi-cli/sessions.db`) |

### Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `BODHI_MODEL` | Default model id |
| `BODHI_SYSTEM_PROMPT` | System prompt text |

### REPL commands

| Command | Description |
|---|---|
| `/help` | List commands |
| `/new` | Start a new session |
| `/sessions` | List sessions for current directory |
| `/resume <id>` | Load a previous session (replays history) |
| `/model <id>` | Switch model for current session |
| `/quit` | Exit |

## Sessions

Sessions are stored in `~/.bodhi-pi-cli/sessions.db` (SQLite, WAL mode). Each session is scoped to the directory where the CLI was launched. Use `/sessions` to list and `/resume <short-id>` to reload.

## Tests

```sh
npm test                              # integration (fs adapter, session store, config)
OPENAI_API_KEY=... npm run test:e2e   # e2e (gpt-5-mini, one prompt turn)
```
