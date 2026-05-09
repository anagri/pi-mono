# bodhi-pi-ws-server

WebSocket-hosted multi-user backend for `@bodhiapp/bodhi-pi`.

## Quick start

```bash
cp .env.example .env
npm run dev
```

Defaults to `http://localhost:8788`. WebSocket endpoint: `ws://localhost:8788/agent`. Health: `http://localhost:8788/healthz`.

## Auth

Clients connect with two subprotocols:

```js
new WebSocket('ws://localhost:8788/agent', [
  'bodhi-pi.v1',
  `bearer.${btoa(JSON.stringify({ id: 1, email: 'alice@example.com' }))}`,
]);
```

Server decodes the `bearer.*` element, validates `{id: number, email: string}`, attaches to the connection. Subprotocols not following this shape get HTTP 401 on upgrade.

## Tests

```bash
npm test
```
