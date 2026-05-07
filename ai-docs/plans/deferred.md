# bodhi-pi — Deferred Decisions

Items intentionally out of scope for v1, to revisit in a later milestone.

| Item | Decision | Reason | Revisit when |
|---|---|---|---|
| **MCP client capability** | Defer to v2 | Keep v1 core minimal; tools come from built-ins + bodhi-pi extensions only. coding-agent has MCP, parity restored later. | After v1 stabilises and a host needs external MCP tool servers. |
| **Image input** | Skip in v1 | Text-only prompts. Reduces token/byte budget and surface area. coding-agent supports images; bodhi-pi will not initially. | Once a host (browser demo or web app) needs multimodal input. |
| **License** | Deferred — likely Apache-2.0 or MIT | Not blocking v1 development. ACP itself is Apache-2.0; matching it eases interop. | Before first public publish to npm. |
| **MCP shapes reuse in protocol** | Implicit via ACP wire | ACP already reuses MCP JSON shapes where applicable; bodhi-pi inherits this for free without depending on MCP runtime. | Coupled to MCP-client revisit. |
| **fs/terminal delegation back to ACP client** | Always in-process injection in v1 | Simpler model; agent owns its host bindings. ACP-style fs/terminal callbacks not implemented. | If a sandboxed-remote scenario emerges where the agent process can't have direct fs/terminal access. |
| **Watch / atomic-rename filesystem capabilities** | Optional, not implemented in default hosts | Capability flags reserved in interface; no host implements yet. | When a feature (live-reload, safe write) demands it. |

## Notes

- All deferred items have placeholder capability flags or interface slots so v2 can light them up without breaking changes.
- Keep this list updated as decisions are made. Move resolved items out; they go into the design doc.
