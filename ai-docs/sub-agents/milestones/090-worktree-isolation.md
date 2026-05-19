# Milestone 090 — Worktree isolation

> **Status:** ☐ pending. Tracked in `../pending.md` as **P4a**. Not yet started.
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md) (Decision 1 — in-process spawn, and the tradeoff this milestone partially restores).
> **Capability scope:** cli-only by design. The browser / chrome-ext / http runtimes have no filesystem isolation primitive equivalent to a git worktree.

## Goal

Add a per-child worktree-isolation option, enforced at child-bootstrap time, that gives a child profile a dedicated working directory (a git worktree, a tempdir, or a copy-on-write clone). Children writing in their working area do not affect the parent's working area; on completion, the parent can inspect the child's working area and merge or discard.

This is the **first per-runtime capability** in the sub-agent feature — it ships behind a host capability flag and is not available on browser / chrome-ext / http by default.

## Functional scope

### IN

- **A per-profile `worktree?: boolean | { strategy: "git" | "copy" }`** field. Default `false`.
- **A host capability flag** — `BodhiPiConfig.allowsWorktreeIsolation?: boolean`. When `false` (default), a profile with `worktree: true` is rejected at discovery time or silently falls back to in-place (designer's call — recommend explicit rejection with a discovery warning).
- **Child-bootstrap respects the worktree option** — if enabled, before the child's prompt-loop starts, the bootstrap creates the worktree, sets the child's `cwd` to the worktree path, registers a teardown hook on `subagent_complete` to clean up (or, if the child wrote useful changes, hand the path back to the parent).
- **A way for the parent to observe the worktree path** — `subagent_complete` carries the worktree path so the parent can `git diff` / `git merge` / `cp -r`.
- **Cleanup policy** — recommend: completed worktrees stay (parent decides); failed/cancelled worktrees are cleaned up by default with an opt-out. Designer's call.
- **`explore` built-in stays worktree-less** — it's read-only by intent.

### OUT

- **Worktree isolation in browser / chrome-ext / http runtimes.** No filesystem isolation primitive exists; faking it via ZenFS clones is theoretically possible but expensive and not in scope.
- **Cross-child worktree sharing.** Each child gets its own worktree; siblings in a batch don't share.
- **Auto-merge of child changes into parent.** The parent reads the worktree path and decides. No magic merge.
- **Read-only worktrees** (chroot-style sandbox preventing writes outside) — a worktree gives the *parent* protection from the child; preventing the child from escaping the worktree is OS-sandboxing territory and not in scope.

## Critical interfaces (recommendation-level)

### Profile field
```
worktree?: boolean | { strategy: "git" | "copy"; cleanup?: "always" | "on-success" | "never" }
```
Recommendation: start with the boolean (`true` → default strategy `git`); add the rich form only if needed. Discovery validation: reject `worktree: true` when the host capability flag is off.

### Host capability flag
```
BodhiPiConfig.allowsWorktreeIsolation?: boolean  // default false
```
cli `test-apps/cli` opts in (`allowsWorktreeIsolation: true`). http / browser / chrome-ext default to false.

### Child bootstrap extension
The current `buildChildSessionState` constructs the child's `SessionState` based on profile + parent. With worktree isolation, it:
1. Creates the worktree (via git `worktree add` or `cp -r`).
2. Sets the child's `cwd` to the worktree path.
3. Registers a teardown hook on session end.

The implementation should keep the worktree operations in a separate module (e.g. `src/subagents/worktree.ts`) gated by runtime — the cli host's adapter imports it; others don't.

### `SubagentCompleteEntry` extension
Add `worktreePath?: string` to the complete entry so the parent can find the path post-hoc.

## Behaviour rules (invariants this milestone must preserve)

1. **All seven locked decisions still apply.** Worktree isolation is about *filesystem* state, not *conversation* state or *tool* state.
2. **The cross-runtime parity invariant is now per-capability** — a profile with `worktree: true` discovered in a chrome-ext host either errors or downgrades. Recommend error (explicit failure beats silent inconsistency).
3. **Worktree creation/cleanup errors are first-class.** A child that fails to create its worktree fails to spawn entirely (its `subagent_complete` records `failed` with an error).
4. **Parent's worktree-path observation is opt-in.** The parent's prompt-loop doesn't automatically `cd` into the child's worktree; it just receives the path.
5. **Children with worktrees still have depth-cap-2.** Recursion (if shipped via milestone 080) does not allow grandchildren to fork their own worktrees off a worktree — keep it simple.

## Where this sits in the research spectrum

Worktree isolation is the **cc + Qwen Code pattern** — both ship it as a cli capability, both require git-as-VCS, both punt on the non-cli runtimes.

Relative to the spectrum:
- **Execution-isolation axis:** moves bodhi-pi from "shared filesystem" to "shared-or-isolated-by-profile (cli)". Browser / chrome-ext / http stay at "shared filesystem" — which is acceptable given those runtimes' typical use cases (browser users don't usually have a multi-branch git workflow).
- **First per-runtime capability flag** in the sub-agent feature — the precedent set here may inform how future per-runtime features get gated (e.g. background mode's resume-after-disconnect challenges).

## Tests / coverage (sketch)

- **Unit:** profile with `worktree: true` discovered in a non-worktree-capable host → discovery warning + profile dropped (or rejected — designer's call).
- **Unit (cli):** child with `worktree: true` runs; verify its `cwd` is the worktree path; parent can read the worktree.
- **Unit (cli):** cleanup policy `always` → worktree gone after `subagent_complete`; `on-success` → worktree gone iff child completed; `never` → worktree persists.
- **Unit:** git worktree creation failure (e.g. dirty parent worktree) → spawn fails cleanly.
- **e2e (cli only):** gpt-4o-mini child writes a file in its worktree; parent verifies the file exists in the worktree path and doesn't exist in the parent's cwd.

## Per-runtime impact

| Runtime | Implementation effort |
|---|---|
| **cli** | Full implementation. Git worktree CLI invocations via `bash` or `simple-git`. `BodhiPiConfig.allowsWorktreeIsolation: true`. |
| **http** | No-op. Capability flag stays false. Profiles requesting worktree get a discovery error. |
| **browser** | Same as http. |
| **chrome-ext** | Same as http. |

This is **the first place** where a sub-agent profile is non-portable across runtimes. The implementing agent should document the policy clearly: profiles authored with worktree intent are cli-only and should be marked as such (e.g. by convention in the profile description).

## Follow-ups / open knobs

- **Tempdir strategy as an alternative to git worktrees** — works in repos without git. Designer's call whether to support.
- **A higher-level "review-this-PR-in-isolation" pattern** built on top of worktrees — would be a separate plan, not a sub-agent milestone.
- **Browser/ZenFS-based pseudo-worktrees** — speculative, not currently scoped.
- **Worktree pool / reuse** — for performance, a host could maintain a pool of warm worktrees. Not scoped.
- **Coordinate with the modes feature** — once permissions ship, the "child can write outside its worktree" question may want a permission rule. Not blocking either side.
