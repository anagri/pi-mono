# Milestone 090 — Persistent always-allow / always-deny rules

> Prerequisites: 010–080 merged.
> **Re-read [005-acp-architecture-decision.md](005-acp-architecture-decision.md).** This milestone is significantly simplified vs the original draft because no new wire methods are needed.

## Updated approach (per 005)

Three significant changes from the original draft:

### 1. NO new wire methods

The original draft introduced `_bodhi-pi/permission/policy/{get,set,list,unset}`. **Drop all four.** The existing `_bodhi-pi/session/settings/*` already supports arbitrary keys. Persisted rules live under `permission.alwaysAllow` / `permission.alwaysDeny` settings keys. Hosts read/edit via the existing `/settings list permission.*`, `/settings set permission.alwaysAllow.<pattern> true`, etc.

### 2. NO scope-picker UI step

The original draft proposed a secondary modal that pops up after the user clicks `allow_always` to ask "session / project / global?". **Drop.** The scope is encoded in `optionId` (3 distinct `allow_always_*` buttons) per milestone 030's updated approach. When the user clicks `allow_always_project`, the agent simply writes the pattern to project scope.

### 3. The work in 090 is mostly:

- `PermissionService.evaluateToolCall` reads `session.settings.effective.permission.alwaysAllow / alwaysDeny` arrays. If a pattern matches the tool name, short-circuit to allow/deny.
- When `requestPermission` returns `{ optionId: "allow_always_<scope>" }`, the PermissionService calls `SettingsService.set(sessionId, "permission.alwaysAllow", [...existing, toolName], scope)`. Same for `reject_always` (defaults to session scope).
- New `/permissions` slash command (per host) is just a thin shortcut over `/settings list permission.*` — optional UX sugar.

### 4. Safety-immune deny list from milestone 060 still wins

`isSafetyImmuneDeny` is consulted BEFORE `alwaysAllow`. A user CANNOT alwaysAllow a path like `.git/HEAD`.

---

## Goal

Make `allow_always` and `reject_always` replies on `requestPermission` actually persistent across sessions:

- Persist `alwaysAllow` and `alwaysDeny` patterns under a settings key (`permission.alwaysAllow: string[]`, `permission.alwaysDeny: string[]`) at the user-chosen scope (`session` | `project` | `global`)
- The host's approval-modal Client UI offers a scope picker when user clicks `allow_always` / `reject_always`. Default scope: `session`.
- `PermissionService.evaluateToolCall` reads these patterns from the merged settings (already accessible via `SessionState.settings`)
- Add an extension method `_bodhi-pi/permission/policy/{get,set,list,unset}` for clients to view + edit rules without going through the approval flow

After this milestone:

- A user who says "always allow `bash`" at session scope sees no future `bash` prompts for that session
- A user who says "always allow `bash`" at project scope sees no `bash` prompts in any future session opened in this cwd
- A user who says "always allow `bash`" at global scope sees no `bash` prompts in any session, anywhere
- Hosts can read/edit rules via `_bodhi-pi/permission/policy/*` (e.g. a `/permissions` slash command that lists current rules and lets the user delete one)

## Pattern format (kept simple in v1)

Patterns are plain tool names. Examples:
- `bash` — allows / denies all bash calls
- `write` — allows / denies all writes
- `github__create_pr` — allows / denies a specific MCP tool
- `subagent` — allows / denies the subagent tool

Future milestone (out of scope here) adds `<toolName>:<argFingerprint>` (e.g. `bash:npm test`). Document explicitly that v1 uses tool-name granularity only.

Wildcard `*` is allowed for category-level matches at the per-tool level (e.g. `*` in `alwaysAllow` is effectively `allow-all` mode — but document and discourage).

## Settings layout

```json
// .bodhi-pi/settings.json
{
  "permission": {
    "alwaysAllow": ["read", "ls", "find", "grep"],
    "alwaysDeny": [],
    "approvalTimeoutMs": 30000
  }
}
```

`PermissionService.evaluateToolCall` consults `session.settings.effective.permission.alwaysAllow/Deny` before any other resolution. Wins over per-tool override, session grant, category default, mode preset.

## Wire methods

```ts
// src/wire/constants.ts
export const EXT_PERMISSION_POLICY_GET    = "_bodhi-pi/permission/policy/get";
export const EXT_PERMISSION_POLICY_SET    = "_bodhi-pi/permission/policy/set";
export const EXT_PERMISSION_POLICY_LIST   = "_bodhi-pi/permission/policy/list";
export const EXT_PERMISSION_POLICY_UNSET  = "_bodhi-pi/permission/policy/unset";
```

| Method | Params | Returns |
|---|---|---|
| `_bodhi-pi/permission/policy/get` | `{ sessionId, scope: "session"\|"project"\|"global"\|"effective", kind: "allow"\|"deny" }` | `{ patterns: string[] }` |
| `_bodhi-pi/permission/policy/set` | `{ sessionId, scope, kind, pattern }` | `{ ok: true }` |
| `_bodhi-pi/permission/policy/list` | `{ sessionId, scope }` (defaults to `"effective"`) | `{ allow: string[]; deny: string[] }` |
| `_bodhi-pi/permission/policy/unset` | `{ sessionId, scope, kind, pattern }` | `{ ok: true }` |

Implementation: `PermissionService.registerWireMethods()` returns these. Backend uses the existing `SettingsService.set/get/unset` to write to the right settings layer (under `permission.alwaysAllow` / `permission.alwaysDeny`).

## Approval-modal scope picker

When a user clicks `allow_always` / `reject_always` in the modal:

```
   "Allow bash always for…"
   [ ] this session
   [ ] this project (cwd)
   [ ] globally
   [Confirm]  [Cancel]
```

Default selection: session. The host's Client passes the chosen scope back to the agent via a `_meta` field on the `RequestPermissionResponse` (ACP allows arbitrary `_meta`). Agent reads `_meta["bodhi-pi"].alwaysScope` and writes the pattern to that scope via `SettingsService`.

If the host's UI doesn't support the scope picker (or it's omitted), agent defaults to `session` scope.

## Scope

### IN

| Change | File |
|---|---|
| `permission.alwaysAllow` / `alwaysDeny` settings keys | Documented in `settings.ts` + `modes.md` |
| `PermissionService.evaluateToolCall` checks settings.effective.permission.alwaysAllow/Deny first | `src/permissions/permission-service.ts` |
| `_bodhi-pi/permission/policy/{get,set,list,unset}` methods | New: `src/permissions/permission-policy-service.ts` (or extend permission-service) |
| Scope picker in approval modal across all 4 Hosts | `test-apps/{cli,http,browser,chrome-ext}/src/client/...` |
| Update `modes.md` row 090 = ☑ + persistence section + wire-method reference | Edit |
| Update `acp.md` — new extension methods | Edit |
| Update `configuration.md` — new settings key `permission` | Edit |
| Default `~/.bodhi-pi/settings.json` permission.alwaysAllow = [] (no auto rules) | Documentation only |

### OUT

- `<toolName>:<argFingerprint>` patterns (future milestone)
- LLM-self-annotated `security_risk` field
- Custom modes via markdown discovery
- MCP per-server overrides

## Tests

### `packages/bodhi-pi/test/permission-persistent-rules.test.ts` (new)

```ts
describe("persistent always-allow / always-deny", () => {
  it("alwaysAllow ['bash'] at session scope: no requestPermission for bash in this session", async () => { ... });
  it("alwaysAllow ['bash'] at project scope persists across new sessions in same cwd", async () => { ... });
  it("alwaysAllow ['bash'] at global scope persists across cwds", async () => { ... });
  it("alwaysDeny ['bash'] blocks bash with reason mentioning the alwaysDeny rule", async () => { ... });
  it("alwaysDeny wins over alwaysAllow when both contain the same pattern", async () => { ... });
  it("alwaysAllow + alwaysDeny + mode preset: priority order verified end-to-end", async () => { ... });
  it("_bodhi-pi/permission/policy/list returns effective merged view", async () => { ... });
  it("_bodhi-pi/permission/policy/set writes to settings layer; .bodhi-pi/settings.json reflects", async () => { ... });
  it("_bodhi-pi/permission/policy/unset removes a pattern", async () => { ... });
  it("approval_always with scope:project writes to project settings", async () => { ... });
  it("safety-immune patterns are NOT overridable by alwaysAllow", async () => {
    // alwaysAllow includes 'write' but the edit target is .git/config — still denied
  });
});
```

### 4-runtime parity

CLI:
- `/permissions` slash command lists current rules
- After `allow_always` choice with scope=project, a fresh session in same cwd auto-allows the tool

Browser / chrome-ext:
- Scope picker in approval modal
- `/permissions` page or panel showing rules

HTTP integration:
- Project-scope persistence via SQLite-backed settings; per-turn rebuild reads the rule back

## Per-runtime impact

| Host | Change |
|---|---|
| cli | `/permissions` slash command + scope picker in approval prompt (extend the y/A/n/N prompt with a scope sub-prompt when user picks A or N) |
| http/browser/chrome-ext | Scope picker in approval modal; `/permissions` panel/page |

## Commit message

```
bodhi-pi modes 090: persistent always-allow / always-deny rules at session/project/global scope

PermissionService.evaluateToolCall consults permission.alwaysAllow /
alwaysDeny from the merged settings layer before mode/category/grant
resolution. Approval modal grows a scope picker for allow_always /
reject_always; default scope is session. Extension methods
_bodhi-pi/permission/policy/{get,set,list,unset} let hosts read/edit rules
without going through the approval flow.

Safety-immune patterns from 060 still cannot be overridden by alwaysAllow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Interactions

- **Settings**: new `permission.*` keys. The `_bodhi-pi/session/settings/list` endpoint now shows them.
- **Sub-agents**: child sessions inherit the parent's settings (which now includes alwaysAllow/Deny). Document — if a child shouldn't inherit, the profile must override permission policies (out of v1 scope; future milestone).
- **MCP**: MCP tool name patterns work in alwaysAllow (e.g. `github__create_pr`). Useful for "always trust the github MCP server's PR creation".
- **Skills `allowed-tools`**: a skill's allowed-tools doesn't grant permission — it just restricts which tools the skill itself can use. Permissions still gate at runtime. Document.

## Risks

- **Risk**: A user might write a too-broad alwaysAllow pattern (e.g. `*`) and effectively be in allow-all mode without knowing. **Mitigation**: log a warning at session bootstrap if alwaysAllow contains `*`. The safety-immune list still applies.
- **Risk**: HTTP per-turn rebuild reads settings each request — fine for project/global (file-based) but session-scope settings live in `sessionOverrides` (in-memory). Verify session-scope alwaysAllow survives rebuild via the SessionStore (it doesn't — session-scope settings are intentionally ephemeral). Document.

## Definition of done

- [ ] alwaysAllow/Deny consulted in evaluateToolCall
- [ ] 4 wire methods implemented
- [ ] Scope picker in modal across all 4 Hosts
- [ ] All tests pass
- [ ] `modes.md` + `acp.md` + `configuration.md` updated
- [ ] Single commit
