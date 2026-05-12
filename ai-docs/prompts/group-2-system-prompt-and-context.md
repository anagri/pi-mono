# Phase G — System prompt & context foundations

**Read first:** `ai-docs/prompts/process.md` (working rules + retrospective)
AND `ai-docs/prompts/group-0-upstream-alignment.md` (Phase 0 must complete
before this phase — its harness audit affects how outcome #1 is built).
**Reference impl:** `packages/coding-agent/src/core/system-prompt.ts` and
`packages/coding-agent/src/core/resource-loader.ts`. **Also**
`packages/agent/src/harness/system-prompt.ts` — upstream's new generic
system-prompt composer (added in the 0.74 sync); compare and decide reuse.
**Current state:** `packages/bodhi-pi/PARITY.md`.
**Source intent:** `ai-docs/parity-post-extension.md` §3.4.

> **Upstream context (2026-05-11):** Outcome #1 ("default system prompt
> with built-in tool descriptions") may be partially satisfied by
> `harness/system-prompt.ts` if Phase 0's audit adopts it. The harness
> composer is generic (no coding-agent-specific tool descriptions);
> bodhi-pi may still need a coding-flavoured layer on top. Re-read this
> phase's outcomes after Phase 0 lands.

---

## Functional outcomes

After this phase a user of any bodhi-pi reference host should observe:

1. **Models use bodhi-pi's built-in tools correctly out of the box.** Today
   hosts must hand-write a system prompt describing every tool; with this
   phase, the agent ships a built-in system prompt that explains its
   built-in tools so a host that passes no `systemPrompt` still gets
   sensible tool use.
2. **Hosts can append to that built-in prompt** rather than only override.
   A new "append" surface (config field or environment variable) lets a
   host add project-specific guidance without losing the tool descriptions.
3. **The agent automatically picks up project-rooted instructions.**
   When `AGENTS.md`, `SYSTEM.md`, or `CLAUDE.md` exists at the session's
   `cwd` (or a parent), its contents are merged into the system prompt
   without the host configuring anything.
4. **Settings merge.** A `.bodhi-pi/settings.json` in the workspace, and
   optionally `~/.bodhi-pi/settings.json` at the user level, populate
   default config (compaction thresholds, model preferences, etc.). Project
   settings win on collision.
5. **Skills with `allowed-tools` actually enforce that list at runtime.**
   A skill declaring `allowed-tools: [read, grep]` cannot dispatch `write`
   or `run_script` even if the model attempts to.

Each outcome must be observable through the public ACP/UI surface — no
whitebox tests against internal config state.

---

## Rough directional pointers

Don't take these as prescriptive — confirm by reading the code first.

- **Default system prompt + tool descriptions:** start from
  `packages/coding-agent/src/core/system-prompt.ts`. Today bodhi-pi's
  `_buildSessionState` in `packages/bodhi-pi/src/acp/agent.ts` composes
  the system prompt from `composeSystemPrompt(host-supplied, skills)`;
  this is where the new "built-in + host-supplied" composition lands.
- **Append vs override:** today `BodhiPiConfig.systemPrompt` is
  override-only. Decide the cleanest surface — a separate
  `appendSystemPrompt` field, a discriminator object, or an environment
  variable — by reading the existing pi-coding-agent convention and the
  bodhi-pi-cli flags in `src/cli.ts` / `src/config.ts`.
- **AGENTS.md walk:** `packages/coding-agent/src/core/resource-loader.ts`
  is the reference. Walk happens at session boot inside `_buildSessionState`
  (which already receives `cwd` and the host-injected `Filesystem`).
- **Settings merge:** look for any existing `.bodhi-pi/<dir>` discovery
  pattern in `packages/bodhi-pi/src/commands/discovery.ts` and
  `packages/bodhi-pi/src/skills/discovery.ts`. Settings parsing is similar
  shape; figure out whether settings should land in core or in each host's
  bootstrap.
- **Skill allowed-tools enforcement:** the field is already parsed (see
  `packages/bodhi-pi/src/skills/`). The runtime check happens at tool
  dispatch — likely in the `beforeToolCall` hook composed inside
  `_buildSessionState`, gated by whether the active turn was invoked
  through a skill.

---

## Test signals to design for

Functional, blackbox:

- Built-in prompt: a model with NO host-supplied systemPrompt completes a
  task that requires using a built-in tool correctly (e.g., reading a file
  whose path it's told to look at). Faux-provider test asserts the
  `systemPrompt` field the agent sent contains tool documentation; real-LLM
  e2e asserts the tool was actually called.
- Append: with `host-supplied prompt` + `appended fragment`, both appear
  in the LLM payload.
- AGENTS.md walk: seed a workspace with `AGENTS.md` containing a
  distinctive instruction ("always reply with the codeword TROPIC"); a
  fresh chat reflects it. Across all five hosts.
- Settings merge: project settings override user-level; ergonomic to
  verify via a slash command that surfaces resolved config (consider a
  `/config` or extension to `/session`).
- Skill `allowed-tools`: skill declaring `allowed-tools: [read]` invoked
  via `/skill:<name>` cannot trigger `write`. Faux-provider test asserts
  the dispatch is blocked + the model receives an explanatory tool-result
  error.

If any of the above feels like it would require whitebox access, design a
new `_bodhi-pi/<area>/<verb>` extension method to surface the state instead
(we did this for `/entries` and `/tree` to make `/fork` and `/goto`
testable through the UI).

---

## Open questions to confirm before coding

Use `AskUserQuestion` once you've read the code. Likely topics:

- Built-in prompt: replace, prepend tool descriptions, or expose a builder
  the host composes? (Original parity report's §5 open question #3 — still
  open.)
- Append surface: separate config field vs combining via env var.
- AGENTS.md / CLAUDE.md / SYSTEM.md: which filenames to honor and in what
  precedence; walk parents or `cwd`-only.
- Settings.json location: `.bodhi-pi/settings.json` (project) +
  `~/.bodhi-pi/settings.json` (user)? Or a different convention?
- Skill `allowed-tools`: enforce only for `/skill:` invocations or also
  for any turn after the skill was activated?

---

## Boundaries

In scope:

- Default system prompt + tool descriptions
- Append vs override
- AGENTS.md / SYSTEM.md / CLAUDE.md walk
- `.bodhi-pi/settings.json` merge (project + user)
- Skill `allowed-tools` runtime enforcement

Explicitly out of scope (defer to a later phase):

- Tool snippet customization in system prompt (§3.4 P3 — niche)
- Sub-agents (`.claude/agents/`) (excluded by design)
