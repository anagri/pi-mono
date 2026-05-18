# opencode — modes & permissions deep-dive notes

## Key architectural decision: modes ARE agents

opencode **unifies "Modes" and "Agents" into a single concept**. There is no separate `Mode` module. Each "mode" (build, plan, explore) is an `Agent.Info` record with `mode: "primary" | "subagent" | "all"` (a *visibility* classifier, not the operating semantics). The operating semantics come from the agent's *name* + *permission ruleset* + *prompt* + *model*.

## Agent / mode schema

`packages/opencode/src/agent/agent.ts:28-48`:

```ts
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(Schema.Struct({ modelID, providerID })),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
})
```

## Discovery and merge layers

`packages/opencode/src/config/agent.ts:132-160` + `config.ts:620, 696-703`:

1. Built-in agents (hardcoded): `build`, `plan`, `general`, `explore`, `scout` (experimental), `compaction`, `title`, `summary`
2. `{agent,agents}/**/*.md` markdown
3. `{mode,modes}/*.md` markdown — auto-merged as `mode: "primary"`
4. `opencode.json` → `config.agent`
5. `config.mode` keys auto-converted to primary agents:
   ```ts
   for (const [name, mode] of Object.entries(result.mode ?? {}))
     result.agent = mergeDeep(result.agent ?? {}, { [name]: { ...mode, mode: "primary" } })
   ```

## Permission ruleset

`packages/opencode/src/config/permission.ts:1-59`:

```ts
export const Action = Schema.Literals(["ask", "allow", "deny"])
export const Object = Schema.Record(Schema.String, Action)   // per-pattern
export const Rule = Schema.Union([Action, Object])           // shorthand or detailed

InputObject = {
  read?, edit?, glob?, grep?, list?, bash?, task?, external_directory?,
  todowrite?, question?, webfetch?, websearch?,
  repo_clone?, repo_overview?, lsp?, doom_loop?, skill?
}
```

Shorthand normalization:
```ts
typeof input === "string" ? { "*": input } : input
```

So `edit: "ask"` ≡ `edit: { "*": "ask" }`.

## Evaluation: last-match-wins

`packages/opencode/src/permission/evaluate.ts:9-15`:

```ts
export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
```

Wildcard match both axes; default to `ask`.

## Permission.ask flow

`packages/opencode/src/permission/index.ts:32-238`:

```ts
class Request {
  id, sessionID,
  permission: string,         // "edit"
  patterns: string[],         // ["src/**.tsx"]
  metadata,
  always: string[],           // patterns that get auto-granted on "always" reply
  tool?: ...
}

Reply = "once" | "always" | "reject"
```

Decision chain:
- Expand config → ruleset via `Permission.fromConfig`
- For each pattern: `evaluate(permission, pattern, ruleset, approved)`
- Any `deny` → throw `DeniedError(ruleset)`
- All `allow` → return
- Else → create `Request`, publish `Event.Asked`, await user reply via `Deferred`
  - `once` → succeed once
  - `always` → push patterns into in-memory `approved` ruleset; succeed all matching pending requests
  - `reject` → `RejectedError` for this; reject all pending in same session

Error types:
```ts
RejectedError, CorrectedError(feedback: string), DeniedError(ruleset)
```

## Mode → permission examples

`packages/opencode/src/agent/agent.ts:142-200`:

**`plan`** — read-only with markdown plan file allowlist:
```ts
permission: Permission.merge(defaults, Permission.fromConfig({
  question: "allow",
  plan_exit: "allow",
  edit: { "*": "deny", [".opencode/plans/*.md"]: "allow" },
}), user)
```

**`explore`** (subagent) — deny everything, allowlist read-only:
```ts
permission: Permission.merge(defaults, Permission.fromConfig({
  "*": "deny",
  grep: "allow", glob: "allow", list: "allow", bash: "allow",
  webfetch: "allow", websearch: "allow", read: "allow",
  external_directory: readonlyExternalDirectory,
}), user)
```

Defaults always include `doom_loop: ask`, `repo_clone: deny`, `.env` files: ask.

## Subagent permission inheritance

`packages/opencode/src/agent/subagent-permissions.ts:17-34`:

```ts
deriveSubagentSessionPermission({ parentSessionPermission, parentAgent, subagent }) {
  const canTask = subagent.permission.some(r => r.permission === "task")
  const canTodo = subagent.permission.some(r => r.permission === "todowrite")
  const parentAgentDenies = parentAgent?.permission.filter(
    r => r.action === "deny" && r.permission === "edit"
  ) ?? []
  return [
    ...parentAgentDenies,                                // ★ parent edit denies flow through
    ...parentSessionPermission.filter(r => r.permission === "external_directory" || r.action === "deny"),
    ...(canTodo ? [] : [{ permission: "todowrite", pattern: "*", action: "deny" }]),
    ...(canTask ? [] : [{ permission: "task",      pattern: "*", action: "deny" }]),
  ]
}
```

**Critical insight**: if parent is in `plan` mode, its `edit: deny` rules propagate to children. Subagents cannot escape parent's plan-mode restriction.

## disabled() helper

`packages/opencode/src/permission/index.ts:291-302`:

```ts
const EDIT_TOOLS = ["edit", "write", "apply_patch"]
function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  // tool is disabled when its permission has pattern:"*" action:"deny"
}
```

Used to hide UI affordances for tools the current mode globally denies.

## Translating to bodhi-pi

| opencode mechanism | Bodhi-pi take |
|---|---|
| Agent IS mode (no separate Mode module) | Tempting. But bodhi-pi already ships `SubagentProfile` for child sessions. Conflating modes-and-agents would mean *every* mode change spawns a new "primary agent" — heavy. Keep modes as orthogonal: `AgentMode` is a small enum; `SubagentProfile` stays separate; both can override permission policy. |
| Per-tool permission keys (`edit`, `bash`, `read`, ...) | Adopt directly. Map onto existing `toolKindFor` axes (`read \| edit \| search \| execute`) plus per-tool keys (`bash`, `subagent`, `mcp__*`). |
| `Action = "ask" \| "allow" \| "deny"` | Same. The right granularity. |
| Wildcard last-match-wins | Adopt. Predictable, debuggable. |
| `Reply = "once" \| "always" \| "reject"` | Same shape over `_bodhi-pi/permission/respond` wire method. |
| In-memory `approved` ruleset | Same. Persist if user selects "remember globally/per-project" (extra UI choice). |
| Markdown-discovered modes (`{mode,modes}/*.md`) | Defer; bodhi-pi already has skills/commands/subagent markdown. Adding mode markdown is a v3 nice-to-have. |
| Subagent inherits parent edit-denies | Adopt. Codified as "parent's tighter mode floors child's profile mode". |
| `disabled()` UI hint | Add as a settings/effective endpoint so hosts can dim disabled-tool indicators. |
