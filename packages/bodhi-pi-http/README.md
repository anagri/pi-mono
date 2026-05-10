# bodhi-pi-http

HTTP+SSE-hosted reference client for `@bodhiapp/bodhi-pi`. Single Node project containing both the server (under `src/server/`) and frontend (under `src/frontend/`). Wire is **MCP-Streamable-HTTP-shaped**: a single endpoint `POST /acp` carries pure ACP JSON-RPC requests, returning either `application/json` or `text/event-stream` depending on the method.

This host exists to prove a deployment thesis: **each turn = one long-lived HTTP request**. The agent is built fresh from persisted state at the start of every prompt, runs the turn (streaming notifications back as SSE), and is torn down on completion. State lives in storage (SQLite) — not in process memory between requests.

## Quick start

```bash
# from monorepo root
npm install

# create local env
cp packages/bodhi-pi-http/.env.example packages/bodhi-pi-http/.env
# add OPENAI_API_KEY (required for the default model)

# dev (two processes: node :3000 + vite :5173 with /acp proxy)
cd packages/bodhi-pi-http
npm run dev

# open http://localhost:5173
# log in with id=1, email=alice@example.com (any non-empty pair works)
```

## Production

```bash
npm run build         # builds server + frontend
npm start             # serves both /acp and the SPA from :3000
```

## Wire

| ACP method | Response |
|---|---|
| `initialize`, `authenticate`, `session/new`, `session/list`, `session/cancel`, `session/close`, `_bodhi-pi/session/delete` | `application/json` |
| `session/load`, `session/prompt` | `text/event-stream` |

Auth: `Authorization: Bearer <base64url(JSON({id,email}))>`. No login endpoint — clients mint the token. Token has no signature (matches `bodhi-pi-ws-server` PoC posture).

## CLI

```
bodhi-pi-http [options]

  --port <n>            TCP port. 0 for random. Default: env PORT or 3000.
  --workspace <dir>     Single-tenant override: every user uses <dir> as cwd.
  --data-dir <dir>      Data dir (sessions.db + per-user workspaces).
                        Default: env BODHI_PI_HTTP_DATA_DIR or ./.bodhi-pi-http.
  -h, --help            Show help.
```

## Tests

```bash
npm run test           # server unit + integration (faux provider)
npm run test:e2e       # real-LLM happy path (requires OPENAI_API_KEY)
```

See `DEVELOPMENT.md` for noted-skips and design notes.
