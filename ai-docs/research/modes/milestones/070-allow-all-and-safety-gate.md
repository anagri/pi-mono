# Milestone 060 — `allow-all` mode + capability gate + safety-immune deny list

> Prerequisites: 010, 020, 030, 040, 050 merged.

## Goal

Three additions, all small relative to 030 / 050:

1. Add `ALLOW_ALL_PRESET` to `MODE_PRESETS` — all categories `allow`
2. Wire `BodhiPiConfig.allowsAllowAllMode` capability gate into `setSessionMode("allow-all")` (already added to `BodhiPiConfig` in 010; the rejection logic was in 020; this milestone confirms it works against the real preset)
3. Add a hardcoded **safety-immune deny list** that `allow-all` cannot bypass: writes to `.git/**`, `.bodhi-pi/**`, `~/.ssh/**`; reads of `.env*`, `~/.ssh/**`

## `ALLOW_ALL_PRESET`

```ts
ALLOW_ALL_PRESET: ModePreset = {
  mode: "allow-all",
  description: "Auto-approve every tool call. No prompts. Use only when you trust the agent fully.",
  policy: {
    categories: {
      read: "allow", search: "allow", edit: "allow", execute: "allow",
      mcp: "allow", subagent: "allow", other: "allow",
    },
    tools: {},
    alwaysAllow: [],
    alwaysDeny: [],
  },
};
```

## Safety-immune patterns (hardcoded; cannot be bypassed)

```ts
// src/permissions/safety-immune.ts (new file)
export const SAFETY_IMMUNE_DENY_PATHS = {
  edits: [
    /^(?:.*\/)?\.git(\/|$)/,
    /^(?:.*\/)?\.bodhi-pi(\/|$)/,
    /^(?:.*\/)?\.env(\.|$)/,
    /^.*\/\.ssh(\/|$)/,
  ],
  reads: [
    /^(?:.*\/)?\.env(\.|$)/,
    /^.*\/\.ssh(\/|$)/,
  ],
};

export function isSafetyImmuneDeny(toolName: string, args: unknown, cwd: string): { denied: boolean; reason?: string } {
  // resolve path from tool args, check against patterns
  // return { denied: true, reason: "writes to .git are blocked even in allow-all mode" } if match
}
```

`PermissionService.evaluateToolCall` calls `isSafetyImmuneDeny` BEFORE any other resolution step. If safety-immune denies, the result is a `deny` with a clear reason. This sits **above** `alwaysAllow`/session-grants/preset — it cannot be overridden in any mode.

Open question for the implementer: should the rules be configurable? Recommendation: **No for v1.** Make them part of the bodhi-pi-core contract; document in `modes.md`. A future milestone can add an opt-out via Host capability if real demand emerges.

## Host capability defaults

| Host | `allowsAllowAllMode` | `allowsAllowAllModeAsDefault` |
|---|---|---|
| `test-apps/cli` | `true` (cli runs locally; user can sandbox themselves) | `false` (must be explicit per-session) |
| `test-apps/http` | `false` (multi-tenant; admin opts in if needed) | `false` |
| `test-apps/browser` | `false` (untrusted-page concerns) | `false` |
| `test-apps/chrome-ext` | `false` | `false` |

Each Host's `createBodhiPiAgent` call in `test-apps/<host>/src/host/agent.ts` (or equivalent) explicitly sets these. CLI sets `allowsAllowAllMode: true`; others omit (defaults to `false`).

## Scope

### IN

| Change | File |
|---|---|
| `ALLOW_ALL_PRESET` in `MODE_PRESETS` | `src/permissions/presets.ts` |
| `src/permissions/safety-immune.ts` with hardcoded patterns | New file |
| `evaluateToolCall` calls `isSafetyImmuneDeny` first | `src/permissions/permission-service.ts` |
| Host `agent.ts` wiring for `allowsAllowAllMode` | Each `test-apps/<host>/src/host/agent.ts` |
| Update `modes.md` row 060 = ☑ + allow-all section + safety-immune list | Edit |
| Update `hosts.md` — per-Host capability defaults table | Edit |
| Update `configuration.md` — `allowsAllowAllMode` + `allowsAllowAllModeAsDefault` BodhiPiConfig rows now have actual semantics | Edit |

### OUT

- Allow-all auto-downgrade after N consecutive auto-approved calls (Cline's `maxRequests`). Useful but adds state machinery; defer.
- User-configurable safety-immune patterns. Defer.

## Tests

### `packages/bodhi-pi/test/permission-allow-all-mode.test.ts` (new)

```ts
describe("allow-all mode", () => {
  it("auto-runs every tool category without requestPermission", async () => { ... });
  it("setSessionMode rejects allow-all when allowsAllowAllMode is false", async () => { ... });
  it("setSessionMode accepts allow-all when allowsAllowAllMode is true", async () => { ... });
  it("DENIES writes to .git/**, .bodhi-pi/**, .env*, ~/.ssh/** even in allow-all mode", async () => { ... });
  it("DENIES reads of .env* and ~/.ssh/** even in allow-all mode", async () => { ... });
  it("safety-immune deny carries a clear reason like 'writes to .git are blocked even in allow-all mode'", async () => { ... });
});
```

### 4-runtime parity

CLI: switch to allow-all (capability default true); tools auto-run.

HTTP: setSessionMode rejected; assert error.

Browser / chrome-ext: rejected; UI shows error toast/explanation.

### Path-resolution tests

Test the regex behaviour: relative paths (`./foo.env`), absolute paths (`/home/user/.ssh/id_rsa`), normalised paths (path traversal). Use `src/tools/index.ts::resolvePath` for normalisation.

## Per-runtime impact

| Host | Change |
|---|---|
| cli | Sets `allowsAllowAllMode: true` in factory call; user can switch to allow-all via `/mode allow-all` |
| http/browser/chrome-ext | Capability stays false; UI surfaces "allow-all not available on this host" when user tries |

## Commit message

```
bodhi-pi modes 060: allow-all mode + capability gate + safety-immune deny list

Add ALLOW_ALL_PRESET (all categories allow). Implement the
allowsAllowAllMode capability gate (declared in 010 / enforced for absent
preset in 020; this milestone wires it against the real preset). Add a
hardcoded safety-immune deny list that cannot be bypassed in any mode:
edits to .git/.bodhi-pi/.env*/~ /.ssh blocked; reads of .env*/~/.ssh
blocked. CLI host enables allowsAllowAllMode; HTTP/browser/chrome-ext
leave it off (multi-tenant / untrusted-page concerns).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Interactions

- **Skills `allowed-tools`**: skills that whitelist tools could allow allow-all behaviour for those tools even in `ask` mode. The skill's allowed-tools list flows through the per-tool `tools: {}` override in the policy. Document in `modes.md` and `extensions-skills-commands.md`.
- **Sub-agents in 070**: Qwen rule means an `allow-all` parent permits an `allow-all` child trivially; an `ask` parent that spawns a profile with `mode: "allow-all"` requires `allowsAllowAllMode: true` capability (`resolveChildMode` demotes if not capable). Already handled in the Qwen rule in 000-overview.

## Risks

- **Risk**: Safety-immune patterns may be too aggressive (e.g. a tool legitimately needs to write `.gitignore`). **Mitigation**: regex matches `.git/` directory entries, not files starting with `.git` (`.gitignore` is NOT denied). Verify the regex in tests.
- **Risk**: Path resolution differs across runtimes (Windows vs POSIX). **Mitigation**: bodhi-pi already standardises on `pathe` (POSIX-style). The safety regexes are POSIX-shaped — verify they match correctly on Windows-style paths if a CLI host happens to run on Windows. May need to normalise to POSIX before regex match.

## Definition of done

- [ ] ALLOW_ALL_PRESET in `presets.ts`
- [ ] `src/permissions/safety-immune.ts` implements the deny list
- [ ] CLI host wires `allowsAllowAllMode: true`; others leave it false
- [ ] All tests pass; safety-immune tests cover all listed patterns
- [ ] `modes.md` + `hosts.md` + `configuration.md` updated
- [ ] Single commit
