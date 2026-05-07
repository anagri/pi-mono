# bodhi-pi — Skipped (Out of Scope)

Items deliberately **not** in the bodhi-pi roadmap. Different from `deferred.md` — these are choices we're not planning to revisit unless concrete demand emerges.

| Item | Reason |
|---|---|
| **A2A (Agent-to-Agent) façade** | A2A solves agent↔agent delegation across vendors; bodhi-pi's mandate is host↔agent embedding. Implementing A2A is a separate product surface. If demand emerges, it would be a separate adapter package, not part of bodhi-pi core. |
| **Google ADK adoption / interop** | ADK is a framework, not a protocol. bodhi-pi is built on `pi-agent-core` and `pi-ai`; adopting ADK would couple us to Google's runtime choices. Borrow ideas (eval-harness pattern) without taking the dependency. |
| **ACP `fs/read_text_file` / `fs/write_text_file` delegation** | bodhi-pi uses its own injected `Filesystem` interface in-process. It does not call back to the ACP client for file reads/writes. ACP wire compatibility is at the session/prompt/event layer only. |
| **ACP `terminal/*` delegation** | Same as above — bodhi-pi uses its own injected `Terminal` interface in-process. The agent never asks the ACP client to spawn processes on its behalf. |
| **TypeScript extensions / jiti loader** | coding-agent uses jiti to load TS extensions with virtual module aliasing. bodhi-pi extensions are **standalone JavaScript only** so they run identically under Node and browser runtimes. No transpiler at runtime. |
| **TUI in core** | bodhi-pi never depends on `pi-tui` or any rendering library. Hosts (CLI, browser, web) own all UI. Agent emits typed events; rendering is a host concern. |

## Notes

If a skipped item is ever reconsidered, move it to `deferred.md` with a "revisit when" trigger before starting work.
