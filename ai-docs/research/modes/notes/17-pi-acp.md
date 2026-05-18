# pi-acp adapter — deep-read

Local: `/Users/amir36/Documents/workspace/src/github.com/svkozak/pi-acp/`. ACP SDK `^0.12.0`.

## What pi-acp is

An ACP adapter that wraps Pi (the parent of bodhi-pi's lineage) — `pi-acp` spawns `pi --mode rpc` as a subprocess and bridges ACP JSON-RPC requests/events between Zed (or other ACP client) and Pi's RPC.

**Status**: MVP, v0.0.23. Single-author project (svkozak). Pi's official ACP path goes through this adapter today.

## How it maps `setSessionMode`

`src/acp/agent.ts:1002-1022`:

```ts
async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
  const session = this.sessions.get(params.sessionId)
  const mode = String(params.modeId)
  if (!isThinkingLevel(mode)) {
    throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
  }
  await session.proc.setThinkingLevel(mode)

  // keep dropdown in sync
  void this.conn.sessionUpdate({
    sessionId: session.sessionId,
    update: { sessionUpdate: 'current_mode_update', currentModeId: mode }
  })

  return {}
}
```

**`modeId` IS the thinking level** — `off | minimal | low | medium | high | xhigh`. The ACP-exposed "modes" are Pi's thinking-level options, not the kind of `ask/plan/edit/allow-all` modes bodhi-pi is building.

This is a different semantic use of ACP modes — and arguably stretches the spec. The spec says modes "often affect the system prompts used, the availability of tools, and whether they request permission before running". Pi-acp uses modes for reasoning depth instead.

**Lesson for bodhi-pi**: bodhi-pi's `ask/plan/edit/allow-all` is closer to the spec's intent. Pi's reasoning level would more naturally fit `category: "thought_level"` in the new ConfigOption surface (already part of the RFD).

## Filesystem: NOT routed through ACP

`README.md:174-176`:
> "No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally."

Pi-acp matches bodhi-pi's "agent owns filesystem" architecture (because pi itself owns fs, and pi-acp is just a transport).

## Permission: pass-through, no engine

No `requestPermission` calls in pi-acp. All permission/approval logic happens inside Pi. The adapter is pure transport.

Bodhi-pi's PermissionService + native ACP `requestPermission` is a step UP from pi-acp's pass-through (pi-acp doesn't surface permissions to the ACP client at all — they happen inside Pi's TUI or are auto-approved).

## ACP version

`@agentclientprotocol/sdk: ^0.12.0` — newer than Zed (0.11.1) and codex-acp (0.11.1). Pi-acp tracks upstream more aggressively.

## Implication for bodhi-pi

- **Don't conflate modes with thinking levels** — pi-acp's choice is opinionated and doesn't match the spec's mode semantics. Bodhi-pi already keeps these separate: mode is one `ConfigOption (id: "mode")`, thinking is another (`id: "thinking"`).
- **Pi-acp is an adapter, not a native ACP server** — bodhi-pi is the native ACP-speaking version of Pi's lineage. Bodhi-pi's design replaces what pi-acp does (transport-only) with first-class ACP method implementations.
- **Pi-acp uses ACP SDK 0.12** — bodhi-pi should use the same or newer to get the latest mode/permission types. Check bodhi-pi's `package.json` for SDK version; align if older.
- **Pi-acp's fs decision (no `fs/*`) confirms the bodhi-pi camp** — Pi family agents own fs.
- **Pi-acp does not implement `requestPermission`** — bodhi-pi is doing strictly more than pi-acp by exposing permissions to ACP clients.
