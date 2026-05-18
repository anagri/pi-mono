# Continue + Aider + OpenHands — modes notes

## Continue (`continuedev/continue`)

Three surfaces: **Chat** (no tools), **Plan** (read-only), **Agent** (all tools), plus an out-of-band inline **Edit** + **Autocomplete**.

Mode = "which tools the model can see". Tool policy enum (`ToolPolicy`):
- `allowedWithoutPermission` — auto-run
- `allowedWithPermission` — show Cancel/Continue buttons
- `disabled` — hidden from the model

`core/tools/policies/fileAccess.ts`:
```ts
export function evaluateFileAccessPolicy(
  basePolicy: ToolPolicy,
  isWithinWorkspace: boolean,
): ToolPolicy {
  if (basePolicy === "disabled") return "disabled";
  if (isWithinWorkspace) return basePolicy;
  return "allowedWithPermission"; // out-of-workspace always confirmed
}
```

Static base policy from tool definition / YAML, then a context-aware function narrows it. `applyToolOverrides.ts` lets users override per tool.

Config via `config.yaml` — `name`, `version`, `schema`, models with **roles** (`chat`, `autocomplete`, `embed`, `rerank`, `edit`, `apply`, `summarize`):

```yaml
models:
  - name: GPT-4o
    provider: openai
    model: gpt-4o
    roles: [chat, edit, apply]
```

No first-class sub-agents.

**Take for bodhi-pi**: the context-narrowing pattern (`isWithinWorkspace` narrows base policy) maps directly. Bodhi-pi has the workspace cwd; promote it to a first-class predicate in the policy function.

Sources: [How Agent Mode Works](https://docs.continue.dev/ide-extensions/agent/how-it-works), [core/tools/policies/fileAccess.ts](https://github.com/continuedev/continue/blob/main/core/tools/policies/fileAccess.ts), [core/tools/applyToolOverrides.ts](https://github.com/continuedev/continue/blob/main/core/tools/applyToolOverrides.ts).

## Aider (`Aider-AI/aider`)

Four chat modes:
- **code** (default) — `EditBlockCoder`/`UDiffCoder`/`WholeFileCoder`
- **ask** — `AskCoder`, no edits
- **architect** — `ArchitectCoder` (subclass of `AskCoder`), two-model planner→editor loop
- **help** — Q&A about Aider itself

Coder classes in [`aider/coders/`](https://github.com/Aider-AI/aider/tree/main/aider/coders).

Edit gating in `Coder.allowed_to_edit()` (`base_coder.py`):
- Hard rule: `full_path in self.abs_fnames` (file must be added to chat)
- Not-in-chat → `confirm_ask("Allow edits to file that has not been added to the chat?", subject=path)`
- New files → `confirm_ask("Create new file?", subject=path)`
- `.gitignore` honoured

Kill switches:
- `--yes-always` (`AIDER_YES_ALWAYS`): every `confirm_ask` returns yes. Does NOT auto-run suggested shell commands.
- `--auto-accept-architect` (default `True`): skip "apply editor's changes?" prompt in architect mode.
- `--no-suggest-shell-commands` (default off): block shell suggestions entirely.

Architect mode = the only built-in delegation. Parent spawns child `Coder` with parent's `editor_model` + `editor_edit_format`; cost/commit merged back. `suggest_shell_commands=False` and `cache_warming=False` explicitly disabled on child → **inheritance is opt-out**.

**Take for bodhi-pi**: the `abs_fnames` allowlist pattern (file must be explicitly added before any edit) is a stronger gate than "workspace check" and is host-agnostic. bodhi-pi could ship this as a `mode: "edit-listed"` variant where the user must `@file.ts` before edits to it land. The split between **global yes-to-all** (`--yes-always`) and **per-flow auto-accept** (`--auto-accept-architect`) is a precedent worth noting — orthogonal knobs, not one flag.

Sources: [Chat modes](https://aider.chat/docs/usage/modes.html), [Options reference](https://aider.chat/docs/config/options.html), [aider/coders/architect_coder.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/architect_coder.py), [aider/coders/base_coder.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py).

## OpenHands (`All-Hands-AI/OpenHands`)

**Cleanest design for non-IDE hosts.** No named modes. Three orthogonal axes:

### 1. ConfirmationPolicy
`openhands/sdk/security/confirmation_policy.py`:
- `AlwaysConfirm()` — gate every action
- `NeverConfirm()` — no gating
- `ConfirmRisky(threshold=SecurityRisk.HIGH, confirm_unknown=True)` — gate at threshold

### 2. SecurityAnalyzer (LLM self-annotation!)
- `LLMSecurityAnalyzer` — **injects required `security_risk` parameter into every tool schema**; the model self-annotates risk during the same generation call. Zero extra API calls.
- `InvariantAnalyzer` — external policy engine.

Risk enum:
```python
class SecurityRisk(str, Enum):
    HIGH = 'HIGH'
    MEDIUM = 'MEDIUM'
    LOW = 'LOW'
    UNKNOWN = 'UNKNOWN'
```

Doc taxonomy:
- LOW: read-only (`ls`, `cat`, `grep`)
- MEDIUM: project-scoped mutations
- HIGH: system-level (`rm -rf`, `sudo`, network with secrets)

### 3. Runtime/Workspace
`openhands/runtime/` — `BaseWorkspace` abstract, concrete:
- `LocalWorkspace` (in-process, no isolation)
- `DockerWorkspace` (default; requires `-v /var/run/docker.sock`)
- `APIRemoteWorkspace`

E2B/Modal/Daytona/Runloop dropped from main in June 2025.

### Loop integration

```python
while conversation.state.execution_status != ConversationExecutionStatus.FINISHED:
    if conversation.state.execution_status == ConversationExecutionStatus.WAITING_FOR_CONFIRMATION:
        pending = ConversationState.get_unmatched_actions(conversation.state.events)
        if not confirm_in_console(pending):
            conversation.reject_pending_actions("User rejected the actions")
            continue
    conversation.run()
```

Wiring:
```python
conversation.set_security_analyzer(LLMSecurityAnalyzer())
conversation.set_confirmation_policy(ConfirmRisky(threshold=SecurityRisk.HIGH))
```

Delegation: `AgentController.start_delegate()` creates child with `is_delegate=True`; child has its own `State` but publishes to shared EventStream. Confirmation policy + analyzer are at Conversation root → child inherits.

### Take for bodhi-pi

- **`LLMSecurityAnalyzer` is the most novel idea** — putting the `security_risk` field on every tool schema and trusting the model is host-agnostic, has zero per-runtime cost. Strong candidate for bodhi-pi behind a model-capability flag (which models reliably self-annotate?).
- **Policy as data, not control flow** (`(SecurityAnalyzer, ConfirmationPolicy)` pair on the conversation) translates cleanly to bodhi-pi's `SessionState` carrying a `permissionPolicy` object.
- **`BaseWorkspace` abstraction** matches bodhi-pi's `Filesystem`/`Terminal` adapters.
- **Confirmation via callback** matches bodhi-pi's `tool_call` extension event already.

Sources: [Security & Action Confirmation](https://docs.openhands.dev/sdk/guides/security), [openhands.sdk.security API](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.security), [OpenHands SDK paper](https://arxiv.org/html/2511.03690v1).
