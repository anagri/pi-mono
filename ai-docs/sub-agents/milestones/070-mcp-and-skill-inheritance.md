# Milestone 070 — MCP + skill inheritance policy

> **Status:** ☐ pending. Tracked in `../pending.md` as **P3c (MCP)** and **P3d (skills)**, merged here because they share the same policy-surface design problem. Not yet started.
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md) (Decision 6 — current MCP-empty stance).

## Goal

Replace the v1–P2b stance of "children get zero MCP tools and no skills" with a profile-declared inheritance policy. Profile authors can opt children into specific MCP tools (per-server, per-tool, or full-inherit-with-deny-list) and can declare skill dependencies that should be loaded into the child's runtime.

This is the highest-demand pending milestone — the current MCP-empty stance forces any sub-agent that conceptually wants to e.g. open a github PR to make the parent do the MCP work and pass results in via task description.

## Functional scope

### IN

- **A profile-level MCP allow/deny policy.** Likely shape: `mcp?: { include?: string[]; exclude?: string[]; servers?: { [serverName]: { include?: string[]; exclude?: string[] } } }`. The implementing agent designs the exact shape based on what the underlying MCP layer can express.
- **Per-profile skill declarations.** Shape: `skills?: string[]` (skill names that the child should load), or richer (`skills?: Array<{ name: string; required?: boolean }>`).
- **Child-bootstrap respects the policy.** `buildChildSessionState` reads `profile.mcp` and `profile.skills`, registers the intersection of {parent's available MCP tools, profile policy} on the child, and loads declared skills into the child's slash/prompt registry.
- **Discovery validation** for the new frontmatter fields.
- **Extension-registered profiles** can also declare MCP + skill policy (parity with markdown).
- **Sensible defaults for the bundled built-ins.** `explore` likely stays MCP-empty (read-only by intent). `planner` may want a read-only MCP subset — implementing agent decides.
- **Cross-runtime parity** — the policy is enforced identically across cli/http/browser/chrome-ext.

### OUT

- **LLM-callable "request more tools mid-run".** A child cannot escalate its tool surface mid-conversation; the policy is fixed at spawn.
- **Per-parent MCP overrides** — the policy lives on the profile, not on the spawn call (Decision 2).
- **Skill loading order / dependency resolution** — out of scope; assumed flat. If a skill depends on another, the parent's resolved skill set is used as the basis.
- **A wholly new permission/approval flow for MCP tool calls in children.** That overlaps with the future modes/permissions feature (see `ai-docs/research/modes/milestones/`); coordinate with the implementing agent of that feature.

## Critical interfaces (recommendation-level)

### Profile shape extension
Recommendation: add `mcp?` and `skills?` as optional fields on `SubagentProfile`. Validation accepts both being absent (current behaviour: zero MCP, zero skill inheritance). Decision-doc-style: explicit allow lists are safer than implicit-inherit defaults — recommend `mcp: { include: [...] }` style rather than "inherit all minus exclude".

### `buildChildSessionState` extension
The current child bootstrap (`src/subagents/build-child-state.ts`) constructs an empty `mcpToolsByServer`. With the policy, it instead intersects the parent's `mcpToolsByServer` with the profile's policy and registers the result on the child. The skill loader needs a comparable hook.

### Discovery + validation
The new fields gain entries in `_validate.ts`. Discovery warnings on:
- Unknown server name in `mcp.servers`.
- Unknown skill name in `skills`.
- Conflicting include/exclude entries (e.g. same tool in both).

### Lifecycle event extension (optional)
`subagent_start` could carry a `mcpToolsGranted: string[]` field so extensions can audit what children actually received. Implementing agent's call.

## Behaviour rules (invariants this milestone must preserve)

1. **All seven locked decisions still apply** — most importantly Decision 2 (profile is source of truth). The MCP/skill policy lives on the profile, not on the spawn call.
2. **Depth-cap-2 still holds.** Children with rich MCP access still cannot themselves spawn children.
3. **The intersection is `{parent's available MCP tools} ∩ {profile's policy}`** — a profile cannot grant the child access to MCP tools the parent doesn't have. This keeps profiles portable across hosts with different MCP wiring.
4. **A profile that requests a skill the parent doesn't have**: discovery warning OR runtime warning at spawn; the child runs without that skill. Designer's call (recommend warn-and-continue).
5. **`explore` (built-in) stays MCP-empty by default**, regardless of profile-side changes. The read-only-investigator intent is preserved.
6. **Cross-runtime parity remains absolute** — the same profile spawns identically in all four runtimes (subject to the parent's MCP availability per runtime).

## Where this sits in the research spectrum

The implementing milestone gives bodhi-pi parity with **Mastra** (per-profile allow/deny lists), **cc** (inherit-with-deny), and **Qwen Code** (deny-by-default with per-profile opt-in). The recommendation toward "explicit allow" matches Qwen Code's posture, which the research report flagged as the safer baseline.

Relative to the spectrum:
- **Tool-policy axis:** moves bodhi-pi from "restricted (zero MCP)" to "policy-derived (per profile)". Closes the largest current gap with the surveyed harnesses.
- **Skill axis:** brings sub-agents into parity with the rest of bodhi-pi's skill/extension model — a notable consistency win.

## Tests / coverage (sketch)

- **Unit:** profile with `mcp: { include: ["github__create_pr"] }` → child's tool list contains that tool when parent has it registered; doesn't when parent doesn't.
- **Unit:** profile with `mcp: { exclude: ["dangerous_tool"] }` (assuming an "inherit minus exclude" mode is supported) → child's tool list omits it.
- **Unit:** profile with `skills: ["pr-review"]` → child's slash registry has the skill's commands.
- **Unit:** discovery rejects malformed policies with clear warnings.
- **e2e (gpt-4o-mini):** a child with `mcp: { include: ["fetch__fetch"] }` actually invokes the MCP tool and uses the result.
- **e2e-ui (Playwright):** UI shows the child's available tool set distinct from parent's.

## Per-runtime impact

| Runtime | Considerations |
|---|---|
| **cli** | Full MCP server set typically available; policy works as designed. |
| **http** | Per-turn-rebuild — the parent's MCP registration is rebuilt every request, so the intersection is recomputed too. No special handling. |
| **browser** | MCP availability depends on what the browser host has wired (typically a more limited set). Policy still works; profiles requesting unavailable tools log warnings. |
| **chrome-ext** | Same as browser. |

The cross-runtime difference is in the *available* MCP tool set, not in the policy mechanism. Profile authors who write portable profiles should keep policies conservative.

## Follow-ups / open knobs

- **MCP per-tool argument allow-lists** (e.g. "child can call `bash` but only with `npm test*` args) — speculative, not in any pending milestone. Adds significant complexity.
- **Skill inheritance with dependency resolution** — beyond scope here. If skill X depends on skill Y, the implementing agent decides whether to auto-load Y or require explicit declaration.
- **Modes/permissions overlap** — once the modes feature ships (separate plan in `ai-docs/research/modes/milestones/`), the per-tool approval flow may want to apply to child MCP calls too. Coordinate.
- **Audit log of granted tools per child** — `subagent_start.mcpToolsGranted` proposed above. Could land here or as a separate observability milestone.
