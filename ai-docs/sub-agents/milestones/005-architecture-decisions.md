# Milestone 005 — Architecture decisions (READ FIRST)

> **This document supersedes any conflicting framing in the other milestone files and in the older `../design.md` / `../roadmap.md`.** Read this BEFORE any milestone. The locked decisions below were made during the V1 → P2b implementation arc and will not be revisited without a new decision doc.

## TL;DR

Seven decisions diverge from one or more harnesses in the research spectrum, and together they define bodhi-pi's sub-agent personality:

1. **In-process spawn** — not separate process, not separate ACP session
2. **Profile is the source of truth** — context mode, model, tools all locked at discovery time; no per-call overrides
3. **Single sub-agent tool with LLM-driven parallelism** — one `subagent` tool; concurrency emerges from the LLM emitting multiple tool calls in one assistant message, dispatched concurrently by pi-agent-core's `Promise.all` executor
4. **Fresh context is the default** — fork is opt-in per profile
5. **Hard depth-cap of 2** — recursion is not configurable; children cannot spawn grandchildren
6. **MCP-empty for children in v1** — children get zero MCP tools regardless of parent
7. **Fork = full transcript with type filter** — not "last user prompt" or curated slices

Each decision is followed by what we did instead, why, what we gave up, and where the alternative still lives in the pending milestones.

---

## Decision 1 — In-process spawn

**The spectrum:** Research surveyed four execution models — child session (OpenCode, Gemini CLI, OpenHands), in-process fork (cc, Qwen Code), peer handoff (AutoGen Swarm, Semantic Kernel), and manager orchestration (CrewAI, MetaGPT).

**What bodhi-pi does:** Children run in the same Node process / browser Web Worker / chrome-ext service worker as the parent. The child is a fresh `SessionState` registered in the same `Map<string, SessionState>`, persisted in the same `SessionStore`, and driven by the same `runPromptLoop`. There is no child process, no child ACP connection, and no second runtime.

**Why:**
- **Browser + chrome-ext cannot spawn child processes.** The four-runtime parity rule (cli / http / browser / chrome-ext) forces a design that lives entirely inside a single runtime.
- **Per-turn-rebuild HTTP** can keep `SessionStore` durable but cannot keep a long-lived child process alive between requests.
- The companion `pi-coding-agent`'s `pi-subagents` spawns child CLI processes — that approach is not portable here.

**What we give up:**
- True OS-level isolation (a misbehaving child can in principle affect the parent's memory).
- Process-level resource limits.

**Where the alternative still lives:** Worktree isolation (milestone 090) restores some isolation for the cli runtime via per-child working directory.

---

## Decision 2 — Profile is the source of truth

**The spectrum:** cc, Mastra, Gemini all expose per-call toggles for context mode and tool override on the LLM tool itself. Qwen Code lets the model pick context mode at runtime.

**What bodhi-pi does:** A `SubagentProfile` is fully determined at discovery time. `context: "fresh"|"fork"`, `model?`, `tools?`, `maxTurns` are all locked when the markdown is parsed or the extension registers. The LLM-facing `subagent` tool exposes only `agent`, `task`, and `model?` (where `model?` is the only per-call override).

**Why:**
- **Schema attractor minimisation.** Every per-call parameter on the LLM tool is a knob the model may misuse. The smallest possible parameter surface is the safest. We hit this directly during V2 — the original `context` parameter on the tool became an attractor and was removed (the C0 schema-bug fix).
- **Profile authoring as the policy boundary.** Markdown profile files (and extension-registered profiles) become the place where capability decisions are made — by humans or extension authors, not the LLM at runtime.

**What we give up:**
- A profile cannot be reused across different contexts without duplication (e.g. a "reviewer-fresh" and "reviewer-fork" pair).
- The LLM cannot opt into a richer context for a known-hard task at runtime.

**Where the alternative still lives:** The "per-call slice override" idea was researched during P2a and explicitly deferred — see `../pending.md`. It is not promoted to a forward milestone because the attractor cost outweighs the flexibility win.

---

## Decision 3 — Single sub-agent tool with LLM-driven parallelism

**The spectrum:** Two camps across the surveyed harnesses. (a) Folded batch-as-array: Mastra and cc expose a single tool that takes `tasks: Array<...>` with `minItems: 1`. (b) Parallel tool-use: OpenCode, Gemini CLI, Qwen Code expose a single-task sub-agent tool and rely on the LLM emitting multiple tool calls in one assistant message to get concurrency. Both achieve parallelism — the difference is whether the batching is expressed at the tool-schema level or at the LLM tool-use level.

**What bodhi-pi does:** A single `subagent` tool that takes one task per call. Concurrency is implicit — when the LLM emits N `subagent` tool calls in one assistant message, pi-agent-core's `executeToolCallsParallel` (`packages/agent/src/agent-loop.ts`) runs them through `Promise.all`. Parallel children produce N parallel `subagent_link` → `subagent_complete` entry pairs and N overlapping `subagent_start` / `subagent_end` event windows.

**Why:**
- **Matches the majority pattern.** OpenCode, Gemini CLI, and Qwen Code (the harnesses most aligned with bodhi-pi's child-session model) all use parallel-tool-use over a batch primitive. The research report flagged this as the prevailing pattern in coding-agent harnesses.
- **Schema minimisation (Decision 2's spirit).** Every additional knob on the LLM-facing tool is a knob the model can misuse. `tasks: Array`, `failFast`, per-task model override on a single tool widens the attractor surface. A flat single-task schema is the smallest possible.
- **Concurrency comes for free from `pi-agent-core`.** The `Promise.all` executor was already in place for other tool dispatch; sub-agents inherit it without bespoke plumbing.
- **No new replay surface.** Without batch entries, the `SessionStore` keeps one entry-pair per child — replay is straightforward.

**What we give up:**
- **Reasoning models serialize.** gpt-5-mini and the o-series reliably chunk tool calls one-per-assistant-turn, so multi-child workflows on those models run serially even when the parent's intent is parallel. Non-reasoning models (claude-haiku-4-5, gpt-4o-mini) emit parallel calls per turn. Concurrency behaviour is therefore an authoring/model-selection concern, not an architectural primitive.
- **No tool-level `failFast` semantics.** If a parent wants "abort siblings on first failure", it has to express that itself across multiple turns; the runtime won't cancel in-flight peers automatically when one fails.
- **No tool-level concurrency cap.** The LLM emits however many parallel calls it wants; if downstream pressure (provider rate limits, etc.) matters, that's a service-level concern, not a tool-schema one.

**Where the alternative still lives:** Workflow-handoff graphs (LangGraph, AutoGen Swarm) — which let the parent declare a sequential or parallel pipeline as a first-class artefact — remain a separate future concern, not a sub-agent feature. They would warrant their own decision doc.

---

## Decision 4 — Fresh context is the default

**The spectrum:** cc defaults to fork (full parent transcript). OpenCode defaults to fresh. Mastra defaults vary by profile.

**What bodhi-pi does:** Profiles default to `context: "fresh"` if no value is set in frontmatter. Both bundled built-ins (`explore`, `planner`) are fresh. Fork is opt-in by setting `context: "fork"` in the markdown frontmatter or the extension definition.

**Why:**
- **Token cost.** Fork passes the full filtered parent transcript to the child, multiplying token usage on every spawn.
- **Composability.** A fresh child is a pure function of its task — its output does not depend on parent history. This is easier to reason about for parent-side prompting and for retroactive replay.
- **The built-in cases (`explore`, `planner`) don't need parent context** — the parent's task description is enough.

**What we give up:**
- Fork is the right default for "summarise the last 30 turns" style tasks; fresh forces the parent to copy the relevant context into the task description.

**Where the alternative still lives:** Fork is fully supported (milestone 030). Profile authors who want fork-by-default can set it in their markdown. The default may be revisited if a strong fork-by-default use case emerges, but is not a tracked pending milestone.

---

## Decision 5 — Hard depth-cap of 2

**The spectrum:** Mastra allows unlimited recursion behind an opt-in. cc caps at 3 by default with config override. OpenHands has no hardcoded cap.

**What bodhi-pi does:** `SUBAGENT_MAX_DEPTH = 2` is a constant. Top-level session is depth 0; a child of the top-level is depth 1; a grandchild would be depth 2 but is never spawned because **the `subagent` tool is unconditionally excluded from every child's tool list, regardless of profile.tools**. The cap is enforced as a tool-availability gate, not a runtime check.

**Why:**
- **Loop-safety by construction.** The cap cannot be bypassed by a misbehaving profile or by a model that "really wants" to spawn another child.
- **Reasoning about cost.** With depth ≤ 1, total token cost is bounded by `parent_tokens + sum(child_tokens)` — no exponential blowup.
- **The 2-depth limit covers the bulk of the use cases we've seen.** A planner spawning explorers; a reviewer fanning out to 3 specialists. Neither needs depth 2+.

**What we give up:**
- Long agentic chains (planner → research-coordinator → specialist-explorer) cannot be expressed.

**Where the alternative still lives:** Milestone 080 tracks the opt-in recursion option. The opt-in needs to come with a hard cap (configurable but bounded) and per-profile recursion permissions — neither is currently scoped.

---

## Decision 6 — MCP-empty for children in v1

**The spectrum:** cc inherits MCP from parent. Mastra has per-profile allow/deny lists. Qwen Code denies by default with per-profile opt-in.

**What bodhi-pi does:** When a child session is bootstrapped, its `mcpToolsByServer` map starts empty regardless of what the parent has registered. The child sees only the built-in tools allowed by `profile.tools` (or all built-ins if `profile.tools` is unset) plus zero MCP tools.

**Why:**
- **Half-finished policy surface is worse than no surface.** Inheriting all MCP tools breaks profile-as-source-of-truth (Decision 2); inheriting none is at least predictable.
- **The MCP allow/deny design problem is not solved** — it intersects with skill inheritance (which tools does a skill assume?), per-server vs per-tool granularity, and read-vs-mutate annotations. v1 punts.

**What we give up:**
- A profile that needs `github__create_pr` cannot get it. Authors who want MCP must put it directly on the parent and let the parent call MCP after the child returns.

**Where the alternative still lives:** Milestone 070 (MCP + skill inheritance) is the most-requested pending milestone. The design problem there is the policy surface, not the wiring.

---

## Decision 7 — Fork = full transcript with type filter

**The spectrum:** cc clones the full conversation. Gemini clones the full conversation minus tool internals. Mastra has multiple fork modes. OpenCode does not fork.

**What bodhi-pi does:** When `context: "fork"`, the child receives `cloneTranscriptSlice(parent)` — the full parent message history filtered by `SUBAGENT_FORK_FILTER` to exclude entry types that don't belong in a child's view (`mcp_inclusion_set`, `extension`, `subagent_link`, `subagent_complete`). No "last user prompt only" mode, no per-call slice override, no curated-summary mode.

**Why:**
- **The child needs the prior context to be useful at depth.** A reviewer child wants to see what the parent saw, not just the task.
- **Practical mid-pair-gap exposure is small.** The fork happens at the boundary of a tool call, not mid-tool-call, so pair-completeness issues are rare in practice (and inherit whatever the `_bodhi-pi/session/fork` ext method already does).
- **A single fork strategy is easier to reason about than a per-call menu.**

**What we give up:**
- A profile that wants only the last assistant message (cheap mode) is not available.
- A profile that wants a deterministic 5-turn slice is not available.

**Where the alternative still lives:** "Curated slice" and "per-call slice override" both stay in `../pending.md` but are not promoted to forward milestones. The fork strategy can be revisited if cost or fidelity becomes a real problem.

---

## Cross-cutting invariants

These hold across every milestone and every runtime — code reviews flag violations.

| Invariant | Why |
|---|---|
| `src/subagents/` has no `node:*` imports | Four-runtime parity |
| Children never see the `subagent` tool in their tool list | Depth-cap-2 by construction |
| Children get zero MCP tools in v1 | Decision 6 |
| `SessionStore.list()` defaults to `includeChildren: false` | Don't pollute parent-facing UI |
| Sub-agent lifecycle events flow on both rails (in-process `EventDispatcher` AND ACP `session/update`) | Extensions subscribe in-process; clients render via ACP |
| Child's final assistant message → parent's `tool_result` body, truncated at `SUBAGENT_SUMMARY_MAX_CHARS = 4000` | Return-protocol contract |
| Profile names match `^[a-z0-9-]+$` | Filesystem-safe + URL-safe + tool-schema-safe |
| Profile bodies are trimmed and never empty | Avoids silent system-prompt failures |

## Things explicitly NOT shipped (and not in pending milestones)

These came up during research / design and were considered + rejected. They are not in the pending milestones — promoting them would require a new decision doc.

| Idea | Reason rejected |
|---|---|
| Per-call `context` override on the `subagent` tool | Decision 2 — attractor risk |
| Per-call `tools` override on the `subagent` tool | Decision 2 — policy belongs in profile |
| LLM-callable `switch_mode` / `escalate_depth` tools | Self-elevation risk |
| Curated-summary fork mode (e.g. "last 5 turns") | Decision 7 — adds menu without clear value |
| Multi-tenant cross-session children (child shared between parents) | Conceptually muddy; no demand |
| Re-using a child session for a second task from the same parent | Children are single-task; reuse defeats fresh-context guarantee |
| Synchronous "wait for the user to approve this child spawn" before launch | Approval policy belongs in the future modes/permissions feature, not in sub-agents |

## Summary

The bodhi-pi sub-agent system is conservative on every axis where research showed disagreement — choosing the safer, more-predictable, more-portable option. The cost is a less expressive system; the benefit is one that runs identically across four runtimes, has bounded resource consumption, and exposes the smallest possible LLM-facing attack surface.

Where future demand justifies expansion (background runs, MCP inheritance, recursion), the pending milestones 050–100 carry the framing forward without renegotiating the locked decisions above.
