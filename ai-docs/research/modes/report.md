# Agent Harness Mode and Permission Architecture Research for Bodhi-Pi

**Date:** 2026-05-18
**Target package:** [`anagri/pi-mono/packages/bodhi-pi`](https://github.com/anagri/pi-mono/tree/main/packages/bodhi-pi)
**Companion research:** [Sub-Agent Implementations in Popular Open-Source Agent Harnesses](../sub-agents/Sub-Agent%20Implementations%20in%20Popular%20Open-Source%20Agent%20Harnesses%3A%20Research%20Report%20for%20Bodhi-Pi.md)
**Current sub-agents spec:** [`ai-docs/specs/bodhi-pi/subagents.md`](../../specs/bodhi-pi/subagents.md)

---

## Executive summary

This report surveys how 13 production coding-agent harnesses and 8 framework-level libraries implement **operating modes** (`plan` / `ask` / `edit` / `allow-all`) and **permission policies** (auto-approve / per-tool gating / sandbox confinement). It then proposes a concrete architecture for Bodhi-Pi.

### Three findings shape the recommendation

**1. Modes and permissions are best modelled as orthogonal axes, not a single enum.** The strongest designs — Codex (`AskForApproval × SandboxPolicy`), Mastracode (`mode × permissions × YOLO`), OpenHands (`SecurityAnalyzer × ConfirmationPolicy × Runtime`) — keep them separate. The weakest — Cline's flat `plan | act` — conflates intent with enforcement and lacks a clean knob for "I'm in plan mode but want to auto-approve the read tool".

**2. Plan mode must be both prompt-based and enforced at the call site.** Mastracode's "instructional only" plan mode and cc's "plan permission mode" both rely on prompt steering. Cline's `strictPlanModeEnabled` flag adds a runtime tool-gate after the LLM tries to call a write tool. The right design is defence-in-depth: prompt steers, registry filters (LLM never sees write tools), and call-time gate blocks anyway.

**3. Sub-agent mode inheritance should default to "parent's mode is the floor".** Qwen Code's `resolveSubagentApprovalMode` (permissive-parent-wins, plan-parent-sticks-downward, privileged-modes-quarantined-to-trusted-folders) is the cleanest formal rule. cc takes the same approach with parent-mode overriding child profile. Goose's "no inheritance" stance is fragile and recipe-author-dependent; bodhi-pi should not adopt it.

### Recommended Bodhi-Pi direction

Ship a **four-mode user-facing enum** (`ask | plan | edit | allow-all`) backed by a structured `PermissionPolicy` carrying per-category and per-tool decisions. Modes are presets over the policy; users (or `SubagentProfile`s) can override per-tool rules. Approval requests ride a new `_bodhi-pi/permission/request` ↔ `_bodhi-pi/permission/respond` wire pair plus a `pending_approval` tool-call status, persisted in `SessionState`. Sub-agents inherit parent mode with the Qwen rule. Browser/Chrome-ext runtimes get the same mode surface; OS-level sandboxing stays the **host's** responsibility (via the existing `Filesystem`/`Terminal` adapter wraps), not core's. Implementation phases (in commit order):

- **v1**: `ask | plan | edit | allow-all` modes; per-category policy with allow/ask/deny; `tool_call`-event-level enforcement (reuses existing `ToolCallEventResult.block`); wire approval round-trip; mode lifecycle event on both rails (in-process + wire); persist mode in `SessionState` and `_bodhi-pi/session/settings/*` for default.
- **v2**: `ExtensionAPI.setActiveTools()` for tool-registry swap (so the LLM never sees disabled tools); persistent allow/ask/deny rules (`alwaysAllowed` per pattern); per-mode system-prompt suffix; sub-agent mode inheritance with Qwen rule.
- **v3**: per-tool argument-pattern rules (e.g. `bash:npm test`); `request_permissions` tool for the LLM to ask for elevation; mode markdown discovery; LLM-self-annotated `security_risk` field on tool schemas (à la OpenHands) behind a model-capability flag.

---

## Scope and method

Repositories inspected by source-level read (local clone or GitHub via WebFetch):

| Harness | Location used | Depth |
|---|---|---|
| **Bodhi-Pi** | `/Users/amir36/Documents/workspace/src/github.com/anagri/pi-mono/packages/bodhi-pi/` | Read every relevant file directly (src/acp, src/tools, src/extensions, src/events, src/wire, src/subagents, src/sessions, src/settings) |
| **cc (claude code)** | `/Users/amir36/Documents/workspace/src/github.com/anagri/cc-anaysis/src/` | Dispatched Explore agent; ~28 tool calls into permission/, tools/, types/, keybindings/, main.tsx |
| **opencode** | `/Users/amir36/Documents/workspace/src/github.com/anomalyco/opencode/packages/opencode/src/` | Dispatched Explore agent; ~34 reads into agent/, permission/, config/, session/ |
| **MastraCode + Mastra core** | `/Users/amir36/Documents/workspace/src/github.com/mastra-ai/mastra/{mastracode,packages/core}/src/` | Dispatched Explore agent; ~35 reads into permissions.ts, harness.ts, schema.ts, agents/, tui/ |
| **gemini-cli** | `/Users/amir36/Documents/workspace/src/github.com/google-gemini/gemini-cli/packages/{core,cli}/src/` | Dispatched Explore agent; ~40 reads into policy/, tools/, agents/, services/, config/ |
| **OpenAI Codex** | `/Users/amir36/Documents/workspace/src/github.com/openai/codex/codex-rs/` (Rust) | Dispatched Explore agent; ~41 reads into protocol/src/, core/src/{exec_policy,thread_manager,tools}, sandboxing/, cli/, tui/ |
| **Plannotator** | `/Users/amir36/Documents/workspace/src/github.com/backnotprop/plannotator/apps/{pi-extension,opencode-plugin,codex,gemini,copilot}/` | Direct read of pi-extension/index.ts (1293 LOC), tool-scope.ts, opencode-plugin/plan-mode.ts, READMEs |
| **Cline + Roo Code** | GitHub via WebFetch | Dispatched general-purpose agent; ~32 reads/searches |
| **Continue + Aider + OpenHands** | GitHub via WebFetch | Dispatched general-purpose agent; ~43 reads/searches |
| **Goose + Qwen Code** | GitHub via WebFetch | Dispatched general-purpose agent; ~40 reads/searches |
| **AutoGen / LangGraph / LlamaIndex / PydanticAI / CrewAI / Agno / Semantic Kernel / DeepAgents** | GitHub + docs via WebFetch | Dispatched general-purpose agent; ~31 reads |

Per-harness detailed notes are preserved under [`ai-docs/research/modes/notes/`](notes/). Citations in this document use absolute file paths (for local repos) or GitHub `blob/main/` URLs.

The search vocabulary mirrored the prompt's term list: `mode`, `permissionMode`, `approval`, `approve`, `autoApprove`, `auto-approve`, `allow-all`, `allow_all`, `yolo`, `full-auto`, `sandbox`, `ask`, `plan`, `act`, `edit`, `read-only`, `readonly`, `bypass`, `dangerously`, `tool permission`, `ToolPermission`, `human-in-the-loop`, `interrupt_before`, `requiresApproval`, `confirm`.

---

## Mode taxonomy

Normalized across harnesses, the modes that recur are:

| Mode | Aliases observed | Intent | Typical tool surface |
|---|---|---|---|
| **`ask`** | `default`, `untrusted`, `confirmation_mode`, `approve`, `ALWAYS` (AutoGen) | Every potentially-destructive action requires explicit confirmation | All tools available; write/exec/MCP prompt for each call |
| **`plan`** | `architect` (Aider+Roo), `ask` (Roo), `explore` (opencode subagent), `PLAN` (gemini/Qwen/cc), `chat` (Goose) | Analyze and design without modifying state | Read/search only; planner persona prompt; usually with a `submit_plan` / `exit_plan_mode` exit tool |
| **`edit`** | `auto-edit` / `acceptEdits` / `code` / `act` / `build` / `auto` / `auto_edit` / `AUTO_EDIT` / `smart_approve` | Auto-approve in-workspace file edits; still prompt for shell and out-of-workspace | Read/search/edit auto; exec/MCP prompts |
| **`allow-all`** | `yolo` / `YOLO` / `full-auto` / `auto` (Goose) / `bypassPermissions` / `dangerously-skip-permissions` / `NEVER` (AutoGen) / `dangerously-bypass-approvals-and-sandbox` (Codex) | No prompts at all; trust the agent or wrap with OS sandbox | All tools auto |

Two additional axes recur but are orthogonal to mode:

- **Per-tool override**: `AlwaysAllow | AskBefore | NeverAllow` (Goose), `tools[name] = 'allow'|'ask'|'deny'` (mastracode/opencode), `allowedTools` allowlist (cc/Qwen), `disabled` flag (Continue/Roo). Bodhi-pi adopts the mastracode shape.
- **OS sandbox**: orthogonal in Codex (`SandboxPolicy`), implicit in gemini-cli (`sandbox-exec`/Docker), runtime-pluggable in OpenHands (`BaseWorkspace`). **Bodhi-pi delegates this entirely to the host's `Filesystem`/`Terminal` adapter wraps** — runtime parity (browser/Chrome-ext can't sandbox-exec).

Less universal but worth naming:
- `architect` (Aider, Roo Code) — plan-then-execute with two models; in bodhi-pi this is achievable today via the `planner` sub-agent profile.
- `ask` (Roo Code) — read-only Q&A. Equivalent to bodhi-pi `plan` mode minus the `submit_plan` exit affordance.
- `dontAsk` (cc) — convert all `ask` decisions to `deny`. Not adopted; a `permissions.{tool}=deny` per-tool rule covers the same ground without a new mode.
- `auto` / `smart_approve` (cc / Goose) — LLM classifier judges every call. Defer to v3+; infra cost is high.

---

## Cross-harness comparison table

| Harness | Mode names | Where enforced | Approval flow | Edit behaviour | Shell behaviour | Configuration | Sub-agent inheritance | Key source files |
|---|---|---|---|---|---|---|---|---|
| **Bodhi-Pi** (target) | none today | n/a | `ToolCallEventResult.block` from extension events (no UI) | unrestricted | unrestricted (if `terminal` injected) | `BodhiPiConfig`, `_bodhi-pi/session/settings/*` | `SubagentProfile.tools` allowlist; no mode-level inheritance | `src/events/types.ts:142-153`, `src/tools/index.ts`, `src/extensions/types.ts:97-114` |
| **cc** | `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk`, `auto` (ant-only) | tool-policy pipeline → mode bypass → rule allow | rule-based (deny/ask/allow) + per-tool `checkPermissions` + Shift+Tab cycle | `acceptEdits` auto; `plan` requires approval (read-only by tool defaults) | always prompts in default; `bypassPermissions` gated by sandbox+root check | `--permission-mode`, `--dangerously-skip-permissions`, `~/.claude/settings.json` | parent mode overrides child if permissive (`bypassPermissions/acceptEdits/auto`); spawned via CLI flag | `src/types/permissions.ts:16-38`, `src/utils/permissions/permissions.ts:473-1319`, `src/tools/AgentTool/runAgent.ts:415-479` |
| **opencode** | mode IS agent: `build`, `plan`, `general`, `explore`, `scout` | per-tool `Permission.ask` → wildcard last-match-wins | `Reply = once \| always \| reject`; persisted as in-memory `approved` ruleset | `plan` denies `edit:*` except `.opencode/plans/*.md`; `build` allows | per-tool `bash:` rule; user `ask` reply remembered | `opencode.json`, `{mode,modes}/*.md`, `{agent,agents}/**/*.md` | `deriveSubagentSessionPermission`: parent's `edit:deny` rules + `external_directory` + denies flow through | `packages/opencode/src/agent/agent.ts:28-48,142-200`, `packages/opencode/src/permission/index.ts:32-238`, `subagent-permissions.ts:17-34` |
| **MastraCode** | `build`, `plan`, `fast` (modes) + YOLO + permissions (separate axes) | three orthogonal layers: mode (system prompt), permissions (per-category/tool), YOLO (override) | per-category `allow/ask/deny` + session grants; LLM stream emits `tool-call-approval` chunks | `submit_plan` tool + planner system prompt; tools not filtered | `execute` category prompts unless YOLO/session grant | `~/.mastracode/settings.json` + `/yolo`, `/sandbox`, `/permissions`, `/mode` slashes | subagent runs with parent's permission rules + YOLO via shared request context | `mastracode/src/permissions.ts`, `mastracode/src/index.ts:372-395`, `packages/core/src/harness/harness.ts:548-574,2354-2387` |
| **gemini-cli** | `default`, `auto_edit`, `yolo`, `plan` (`ApprovalMode` enum) | per-tool `shouldConfirmExecute` → MessageBus → 30s confirmation | `ToolConfirmationOutcome { ProceedOnce/Always/AlwaysServer/AlwaysTool/ModifyWithEditor/Cancel }` | `respectsAutoEdit` flag bypasses confirmation in `auto_edit` | macOS sandbox-exec / Linux Docker/Podman / Windows nothing | `--yolo`, `--approval-mode`, `~/.gemini/settings.json` (yolo CLI-only) | Local executor inherits sandbox+MessageBus+approval mode; isolates tool registry | `packages/core/src/policy/types.ts:48-65`, `packages/core/src/tools/tools.ts:47-371,1094-1118`, `agents/local-executor.ts:120-146` |
| **Codex** | `AskForApproval × SandboxPolicy` orthogonal axes: `untrusted/on-failure/on-request/never/granular` × `read-only/workspace-write/danger-full-access/external-sandbox` | OS sandbox (Seatbelt/Landlock) + approval-policy decision combinator | per-command policy match → forbidden/prompt/allow; mid-session change DISABLED | sandbox path-scoping; approval policy decides whether to prompt | sandbox-confined exec; `--never` returns failures to model | `~/.codex/config.toml` + `--ask-for-approval`, `--sandbox`, `--dangerously-bypass-approvals-and-sandbox` | `spawn_subagent` forks parent `Config` verbatim (no per-child isolation) | `codex-rs/protocol/src/protocol.rs:900-931,991-1042`, `core/src/exec_policy.rs:272-379`, `thread_manager.rs:612-638`, `sandboxing/src/seatbelt.rs` |
| **Cline** | `plan \| act` (closed) | `strictPlanModeEnabled` runtime guard in `ToolExecutor.ts` + 8-flag auto-approve matrix | webview chat + diff editor; `Task.ask` suspends loop; `maxRequests` cap | act mode auto-approves writes if `editFiles` flag on | safe vs all commands split (`executeSafeCommands`/`executeAllCommands`) | global `StateManager`; toggle in `ChatTextArea`; `yoloModeToggled` siblings | implicit (no first-class subagent); YOLO escalates plan→act | `src/shared/AutoApprovalSettings.ts`, `src/core/task/ToolExecutor.ts`, `src/shared/tools.ts` |
| **Roo Code** | open `ModeConfig`: `architect`, `code`, `ask`, `debug`, `orchestrator` + custom | per-mode group membership + file-regex (`groupEntryArraySchema`) in `validateToolUse` | webview chat + diff; `alwaysAllow*` toggles + execute-command allowlist | groups: `read/edit/command/mcp/modes`; `[group, {fileRegex, description}]` tuple narrows | `command` group only if mode declares it; allowlist | YAML `.roomodes` (project) → `~/.roo/...` (global) → defaults; whole-record override | LLM can `switch_mode`; modes inherit nothing per-call (each invocation re-resolves) | `packages/types/src/mode.ts`, `src/shared/modes.ts`, `src/shared/tools.ts`, `src/core/tools/validateToolUse.ts` |
| **Continue** | Chat / Plan / Agent (no tools / read-only / all tools); inline Edit + Autocomplete | `ToolPolicy` per tool: `allowedWithoutPermission | allowedWithPermission | disabled` | per-tool dialog; out-of-workspace narrows base policy to `allowedWithPermission` | tool-level config; `apply` model role | tool-level config | `config.yaml` model roles `[chat,edit,apply,autocomplete,embed,rerank,summarize]` | no first-class subagent | `core/tools/policies/fileAccess.ts`, `core/tools/applyToolOverrides.ts`, `core/tools/builtIn.ts` |
| **Aider** | `code`, `ask`, `architect`, `help` (Coder subclasses) | `Coder.allowed_to_edit()` checks `full_path in self.abs_fnames`; in-chat allowlist | `io.confirm_ask` per file/operation; `--yes-always` blanket override; `--auto-accept-architect` per-flow | edit format orthogonal (editblock/udiff/wholefile/patch); `architect` two-model planner→editor | `--no-suggest-shell-commands` blocks suggestions; no auto-exec without `--auto-test` | `--chat-mode`, `/code`, `/ask`, `/architect`, `/help`, env `AIDER_YES_ALWAYS` | architect spawns child Coder with parent's `editor_model`; inheritance is opt-out (`suggest_shell_commands=False` on child) | `aider/coders/base_coder.py`, `aider/coders/architect_coder.py`, `aider/main.py` |
| **OpenHands** | no named modes; orthogonal `(SecurityAnalyzer, ConfirmationPolicy, Runtime)` | `LLMSecurityAnalyzer` injects `security_risk` field on every tool schema (LLM self-annotates); `ConfirmRisky(threshold=HIGH)` policy | `WAITING_FOR_CONFIRMATION` state in conversation loop | runtime sandbox (Local/Docker/Remote) enforces; no per-tool mode toggle | runtime decides; Local has no isolation, Docker isolates | `conversation.set_security_analyzer(...)`, `conversation.set_confirmation_policy(...)` | `DelegateTool` child publishes to shared EventStream; inherits Conversation-level policy | `openhands/sdk/security/confirmation_policy.py`, `openhands/sdk/security/`, `openhands/runtime/`, `openhands/controller/agent_controller.py` |
| **Goose** | `auto`, `smart_approve`, `approve`, `chat` (`GooseMode`) | `permission_inspector.rs::inspect()` + per-tool `PermissionLevel { AlwaysAllow/AskBefore/NeverAllow }` | user reply `AlwaysAllow/AllowOnce/Cancel/DenyOnce/AlwaysDeny`; LLM classifier (`permission_judge.rs`) decides read-only | smart_approve: auto-approve read-only via LLM judgement; mutating prompts | classifier-driven | `GOOSE_MODE` env, `~/.config/goose/config.yaml`, `/mode <name>` | **none** — subagent rebuilds `AgentConfig` from scratch; mode/permissions not inherited | `crates/goose/src/config/goose_mode.rs`, `crates/goose/src/permission/permission_inspector.rs`, `permission_judge.rs`, `subagent_handler.rs` |
| **Qwen Code** | `PLAN/DEFAULT/AUTO_EDIT/YOLO` (`ApprovalMode`, gemini-cli fork) | folder-trust gate on `setApprovalMode`; subagent inherits via `resolveSubagentApprovalMode`; `prePlanMode` snapshot | inherits gemini-cli's confirmation flow + adds subagent self-deny when headless | `auto-edit` in trusted folder only | gemini-cli's sandbox | YAML frontmatter on subagent files (`approvalMode`, `tools`, `disallowedTools`, `model`) | **explicit Qwen rule**: permissive parent wins; agent frontmatter applies (if trusted); PLAN parent sticks; `Object.create(base)` + tool-registry rebind + cache reset isolates child config | `packages/core/src/config/config.ts`, `packages/core/src/tools/agent/agent.ts:162-194,227-242,245-255`, `subagents/subagent-manager.ts`, `fork-subagent.ts` |
| **AutoGen v0.2** | `human_input_mode = ALWAYS \| TERMINATE \| NEVER` (per-agent) | `get_human_input()` invocation in run loop | session-level mode dictates when prompts occur | n/a (framework, not coding agent) | n/a | constructor arg on `ConversableAgent` | per-agent (no inheritance per se) | `autogen/agentchat/conversable_agent.py` |
| **AutoGen v0.4+** | `input_func`/`approval_func` per-agent callbacks | per-call hook | callback-based | n/a | n/a | `UserProxyAgent(input_func=...)`, `CodeExecutorAgent(approval_func=...)` | inherits at team-level | `_user_proxy_agent.py` |
| **LangGraph** | implicit (paused thread) | `interrupt()` resumable exception; `Command(resume=...)`; static `interrupt_before/after` on `StateGraph.compile()` | checkpointer persists pause state; replay on resume | n/a | n/a | `compile(checkpointer=cp, interrupt_before=["tools"])` | inheritance via graph state | `libs/langgraph/langgraph/types.py` |
| **DeepAgents** | `HumanInTheLoopMiddleware` over LangGraph | per-tool `interrupt_on` map | LangGraph's `interrupt`/`Command(resume=...)` underneath | n/a | n/a | `HumanInTheLoopMiddleware(interrupt_on={...})` | inherited via LangGraph | `libs/deepagents/deepagents/middleware/subagents.py` |
| **LlamaIndex** | event handshake | tool `await ctx.wait_for_event(HumanResponseEvent)` | event-driven | n/a | n/a | Context-store driven | inherited via workflow context | `llama_index.core.workflow` |
| **PydanticAI** | per-tool `requires_approval=True` + `DeferredToolRequests` output type | run returns `DeferredToolRequests` containing pending approvals + external calls | host resolves and re-runs with `deferred_tool_results=...` | n/a | n/a | tool decorator | re-run model | `pydantic-ai` |
| **CrewAI** | `Task(human_input=True)` + `Agent(allow_delegation=...)` | blocking `input()` per task | per-task flag | n/a | n/a | task/agent constructor | `allowed_agents` for hierarchical delegation | `crewai` |
| **Agno** | per-tool `requires_confirmation=True`; `is_paused` + `continue_run()` | run-level pause | resume via `continue_run(run_id, requirements)` | n/a | n/a | `@tool` decorator | inherited | `agno` |
| **Semantic Kernel** | filter pipeline + `context.Terminate` | `IAutoFunctionInvocationFilter` short-circuits or terminates auto-function-calling loop | filter-defined | n/a | n/a | DI-registered filter | filter applies to all agents | `Microsoft.SemanticKernel.Filters` |

---

## Implementation methodologies

Grouping the harnesses by the dominant pattern they use:

### A. Prompt-only mode switching
- **MastraCode** plan mode (instructional, no tool filtering)
- **Aider** ask/architect (Coder subclass picks system prompt and disables edit calls in code paths)

**Limitation**: LLMs sometimes ignore instructions. Bodhi-pi will not rely on prompt-only enforcement for any safety-critical mode (plan-mode write-blocking is enforced at the call site).

### B. Tool-registry filtering (compile-time / session-start)
- **opencode** `agent.permission` removes deny-rules; `disabled()` helper hides UI affordances
- **Roo Code** mode declares `groups: [read, edit, ...]` and tool is hidden if not in group
- **Continue** `ToolPolicy: disabled` hides the tool entirely
- **mastracode** `permissionRules.tools[name] === 'deny'` strips from tool set passed to model

**Strength**: LLM never sees disabled tools → no wasted tokens, no blocked-call confusion. This is the v2 direction for bodhi-pi.

### C. Permission/approval middleware (call-time gating)
- **cc** `hasPermissionsToUseTool` pipeline (deny → ask → tool-check → bypass → allow → ask)
- **gemini-cli** `BaseToolInvocation.shouldConfirmExecute` → MessageBus
- **opencode** `Permission.ask` per-pattern
- **Goose** `permission_inspector.rs::inspect()`
- **Codex** `exec_policy.rs::create_exec_approval_requirement_for_command`
- **Semantic Kernel** `IAutoFunctionInvocationFilter`
- **PydanticAI** `requires_approval` → deferred tool result
- **bodhi-pi** today: `ToolCallEventResult.block` from `tool_call` extension event

**This is bodhi-pi's v1 surface.** The existing `tool_call` event already supports `{ block: true, reason: "..." }`. Bodhi-pi just needs to wire a built-in mode-aware policy handler that consults `SessionState.mode` + `SessionState.permissionPolicy` and returns `block` or proceeds.

### D. State-machine plan/act phases
- **Cline** `Mode = "plan" | "act"`; `strictPlanModeEnabled` runtime guard in `ToolExecutor`
- **Codex** `Granular(GranularApprovalConfig)` selectively enables/disables prompt categories
- **mastracode** `submit_plan` tool flow: agent emits → harness suspends → user approves → switch to `build`
- **Qwen Code** `prePlanMode` snapshot for restore
- **Plannotator** `Phase = idle | planning | executing` with explicit transition tools

**Take**: bodhi-pi's `plan` mode adopts the `submit_plan` flow but the tool stays optional (some teams want continuous plan-mode without explicit submission). On `submit_plan` approval, bodhi-pi auto-transitions to `edit` mode.

### E. IDE UI approval layer
- **Cline** / **Roo Code** webview chat + diff editor approve/reject buttons
- **Continue** webview tool dialog

**Not directly applicable to bodhi-pi** — bodhi-pi has no UI of its own. Hosts (cli/http/browser/chrome-ext) render their own UI; bodhi-pi emits lifecycle events and exposes wire methods for hosts to consume.

### F. OS sandbox / runtime policy
- **Codex** Seatbelt/Landlock with `SandboxPolicy` enum
- **gemini-cli** `sandbox-exec` + Docker/Podman
- **OpenHands** `BaseWorkspace` strategy: `LocalWorkspace`, `DockerWorkspace`, `APIRemoteWorkspace`

**Take**: bodhi-pi pushes this entirely to the host's `Filesystem` and `Terminal` adapter wraps. A Node CLI host CAN layer Seatbelt/Landlock; a browser worker CAN'T. Document this explicitly in the spec. Core declares *intent* via `mode + sandbox.allowedPaths` setting; host enforces.

### G. Profile-based agent modes
- **opencode** modes ARE agent definitions (markdown discoverable); mode = (`prompt`, `model`, `permission`, `tools`)
- **Roo Code** `ModeConfig` (slug + groups + roleDefinition + customInstructions); custom modes YAML
- **cc** `agentDefinition.permissionMode` per profile
- **bodhi-pi today**: `SubagentProfile` already has this shape for **child** sessions

**Take**: bodhi-pi's `SubagentProfile` is the right template, but modes for the PRIMARY session should stay a small enum, not a profile. Mixing primary-mode-as-profile (opencode style) with sub-agent-as-profile means primary mode change spawns a new "primary agent" — heavy and confusing. Keep the two concepts separate.

### H. Allow-all bypass / YOLO
- **cc** `bypassPermissions` (CLI flag + sandbox/root gate)
- **mastracode** YOLO (toggle, persisted optionally)
- **gemini-cli** YOLO (CLI-only, not in settings)
- **Codex** `--dangerously-bypass-approvals-and-sandbox`
- **Goose** `Auto` mode (default for headless)
- **Aider** `--yes-always`

Common: requires explicit opt-in (CLI flag or hot-key). Often gated by safety check (cc requires sandbox + non-root; Codex requires explicit flag). Never the default. Bodhi-pi `allow-all` mode requires:
- Host capability `allowsAllowAllMode: true` (browser/chrome-ext default `false`)
- Session-level wire method call (cannot be set as a persistent project default unless the host opts in via a separate `dangerouslyAllowAllowAllMode` setting flag)

### I. Child-agent permission inheritance/bubbling
- **cc** parent mode overrides child profile if parent is permissive (`bypassPermissions/acceptEdits/auto`)
- **Qwen Code** `resolveSubagentApprovalMode`: permissive-parent-wins, PLAN-parent-sticky, privileged-modes-quarantined-to-trusted-folders
- **opencode** `deriveSubagentSessionPermission`: parent `edit:deny` rules propagate to child
- **Codex** child inherits parent `Config` verbatim
- **Goose** **NO inheritance** (subagent rebuilds `AgentConfig` from scratch)
- **OpenHands** delegate publishes to shared EventStream; inherits Conversation-level policy

**Take for bodhi-pi**: adopt Qwen's `resolveSubagentApprovalMode` semantics (permissive-parent-wins, plan-sticks-down). This is more conservative than Codex's blind inheritance and safer than Goose's no-inheritance. Plug into `SubagentService.spawn`.

---

## Harness-by-harness deep dives

### Bodhi-Pi (current state)

[Full notes](notes/01-bodhi-pi-current-state.md).

Bodhi-pi `main` has no mode or permission concept. Every built-in tool runs unconditionally when the model invokes it. The existing primitives that the mode system will plug into:

- `src/tools/index.ts`: `createBuiltinTools` returns an unconditional tool list; `toolKindFor` classifies as `read | edit | search | execute | other`.
- `src/events/types.ts:142-153`: `ToolCallEvent` + `ToolCallEventResult { block?: boolean; reason?: string }` — extensions can already veto tool calls.
- `src/events/types.ts:61-70`: `BeforeAgentStartEventResult { systemPrompt?: string; userPrompt?: string }` — mode-driven system-prompt suffix goes here.
- `src/wire/constants.ts:65-72`: `_bodhi-pi/session/settings/{get,set,unset,list}` (scope: `global|project|session|effective`) — mode default persistence.
- `src/sessions/session-state.ts`: `SessionState` is the natural home for in-memory mode + session grants.
- `src/extensions/types.ts:97-114`: `ExtensionAPI` — extensions can subscribe to `tool_call`, mutate inputs, return `block`.
- `src/subagents/types.ts`: `SubagentProfile.tools` allowlist already exists for child sessions.
- `CLAUDE.md` pillars: ACP-as-public-contract, no-silent-defaults, both-rails-lifecycle-events, runtime-host-parity.

**Missing API**: runtime tool-set override. Plannotator's pi-extension does `pi.setActiveTools(names)` to swap the LLM-visible tool list on phase change. Bodhi-pi must either (v1) rely solely on call-time block, or (v2) add `ExtensionAPI.setActiveTools(names)`.

### cc (claude code)

[Full notes](notes/02-cc-claude-code.md).

Mode union: `'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto'` (`src/types/permissions.ts:16-38`). Layered enforcement via `hasPermissionsToUseTool` pipeline (`src/utils/permissions/permissions.ts:473-1319`):

1. Deny rules
2. Ask rules
3. Tool-specific `checkPermissions` (`.git/`, `.claude/`, shell-configs)
4. Mode bypass (`bypassPermissions` or `plan + isBypassPermissionsModeAvailable`)
5. Rule-based allow
6. Convert passthrough → ask
7. `auto` mode LLM classifier (ant-only)
8. `dontAsk` mode (convert ask → deny)
9. Async-agent path (auto-deny or run hooks)

Key files: `src/types/permissions.ts`, `src/utils/permissions/permissions.ts`, `src/utils/permissions/PermissionMode.ts`, `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`, `src/tools/EnterPlanModeTool/ExitPlanModeV2Tool.ts`, `src/utils/permissions/bypassPermissionsKillswitch.ts`, `src/utils/permissions/getNextPermissionMode.ts`, `src/keybindings/defaultBindings.ts`, `src/tools/AgentTool/runAgent.ts`, `src/main.tsx`.

Notable design choices:
- **Bypass-immune steps**: deny rules, explicit ask rules, safety paths (`.git/`, shell config files) all survive `bypassPermissions`. Cc never trusts user to grant absolute power.
- **Statsig circuit-breaker** (`bypassPermissionsKillswitch.ts`): allow-all can be disabled mid-session if the gate flips. Useful pattern for kill-switching dangerous modes.
- **Shift+Tab cycle** with context-aware transitions (`getNextPermissionMode.ts`).

### opencode

[Full notes](notes/03-opencode.md).

Modes are agents. `Agent.Info` (`packages/opencode/src/agent/agent.ts:28-48`) carries `name`, `description`, `mode: "primary"|"subagent"|"all"` (visibility), `permission: Permission.Ruleset`, `model`, `prompt`, `steps`. The "operating mode" semantics come from agent name + ruleset + prompt.

`Permission.Action = "ask" | "allow" | "deny"`. `Permission.Rule = Action | Record<string, Action>` (shorthand wildcard). Per-tool keys: `read, edit, glob, grep, list, bash, task, external_directory, todowrite, question, webfetch, websearch, repo_clone, repo_overview, lsp, doom_loop, skill`.

Evaluation: `findLast` wildcard match; default `ask`. `Reply = "once" | "always" | "reject"`. In-memory `approved` ruleset; cleared per-session.

**Sub-agent inheritance**: `deriveSubagentSessionPermission` (`packages/opencode/src/agent/subagent-permissions.ts:17-34`) propagates parent's `edit:deny` rules + `external_directory` rules + any `deny` from parent's session permission. **Critical**: a parent in `plan` mode floors its children — they cannot escape parent's edit-deny.

### MastraCode + Mastra core harness

[Full notes](notes/04-mastracode.md).

Three orthogonal axes — clearest separation among surveyed harnesses:

1. **Mode** (`HarnessMode<TState>` interface, `packages/core/src/harness/types.ts:43-67`): `{id, name, defaultModelId, agent}`. Mastracode ships `build/plan/fast`, all sharing the same `codeAgent`.
2. **Permissions** (`mastracode/src/permissions.ts`): per-category (`read/edit/execute/mcp`) + per-tool overrides; resolution priority **per-tool > session-grant > category > default**.
3. **YOLO** (`mastracode/src/schema.ts:27`): per-thread boolean override.

Plan mode is **purely instructional** — no tool restriction. Plan submission uses a `submit_plan` tool (`packages/core/src/harness/tools.ts:133-199`) that emits `plan_approval_required` event and awaits resolution; on approve, harness auto-switches to `build`.

YOLO via Ctrl+Y (`tui/setup.ts:153-158`). Approval dialog (`tui/components/tool-approval-dialog.ts:17-21`): `approve | decline | always_allow_category | yolo`.

**Stream-chunk approval transport** (`packages/core/src/harness/harness.ts:2354-2387`): the agent itself emits `tool-call-approval` chunks as part of its output stream; harness intercepts before letting the call run. Interesting design but heavy for bodhi-pi to adopt.

Sub-agents inherit parent permissions + YOLO via shared request context. Per-subagent `allowedWorkspaceTools` filters (explore/plan are read-only; execute has no restriction).

Tool removal when denied: `mastracode/src/agents/tools.ts:104-112` — tools with `policy: 'deny'` are stripped from the tool set so the model never sees them.

### gemini-cli

[Full notes](notes/05-gemini-cli.md).

`ApprovalMode` enum (`packages/core/src/policy/types.ts:48-65`): `DEFAULT | AUTO_EDIT | YOLO | PLAN` with explicit `MODES_BY_PERMISSIVENESS` lattice. YOLO is CLI-only (not in `settings.json`).

Per-tool `respectsAutoEdit` flag (constructor arg). In `AUTO_EDIT` mode, tools marked `respectsAutoEdit: true` bypass confirmation; others (Bash, Execute) still prompt.

MessageBus-based confirmation (`packages/core/src/tools/tools.ts:277-371`): tool posts `ToolConfirmationRequest{correlationId, toolCall, serverName}`; awaits `ToolConfirmationResponse` with 30s timeout. Decouples policy from TUI rendering.

`ToolConfirmationOutcome` (`packages/core/src/tools/tools.ts:1094-1102`): `ProceedOnce | ProceedAlways | ProceedAlwaysAndSave | ProceedAlwaysServer | ProceedAlwaysTool | ModifyWithEditor | Cancel`. The `ModifyWithEditor` outcome is particularly useful — user can edit tool input before approval.

`PolicyRule` schema includes `modes?: ApprovalMode[]` — rule applies only in listed modes. Clean way to scope rules.

Subagent (`packages/core/src/agents/local-executor.ts:120-146`): child agent inherits sandbox + MessageBus + parent context (incl. approval mode); has isolated tool registry.

Sandbox: macOS Seatbelt, Linux Docker/Podman, Windows nothing.

### Codex

[Full notes](notes/07-codex.md).

The **orthogonal-axes decomposition** is Codex's headline contribution:

```rust
// codex-rs/protocol/src/protocol.rs:900-1042
pub enum AskForApproval { UnlessTrusted, OnFailure, OnRequest, Granular(GranularApprovalConfig), Never }
pub enum SandboxPolicy  { DangerFullAccess, ReadOnly{network_access}, ExternalSandbox{...}, WorkspaceWrite{writable_roots, network_access, ...} }
```

`Granular` lets users selectively enable approval categories: `sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations`.

OS sandbox: macOS Seatbelt (`sandbox-exec` + `seatbelt_base_policy.sbpl`), Linux Landlock + seccomp (`codex-linux-sandbox` binary), Windows none.

CLI: `--ask-for-approval`, `--sandbox`, `--dangerously-bypass-approvals-and-sandbox` (shorthand for `Never + DangerFullAccess`). Mid-session change is DISABLED — policies are locked at startup.

Sub-agent (`core/src/thread_manager.rs:612-638`): child inherits parent `Config` verbatim including `approval_policy` and `sandbox_mode`. **No per-child isolation** — too permissive for bodhi-pi's profile system.

MCP elicitation gating: `Never` and `Granular(cfg) if !cfg.allows_mcp_elicitations()` auto-deny without surfacing.

### Cline + Roo Code

[Full notes](notes/06-cline-roo.md).

**Cline**: closed `Mode = "plan" | "act"`. `strictPlanModeEnabled` runtime guard in `src/core/task/ToolExecutor.ts` enforces plan-mode tool restriction independently of LLM prompt steering. 8-flag `AutoApprovalSettings`: `readFiles, readFilesExternally, editFiles, editFilesExternally, executeSafeCommands, executeAllCommands, useBrowser, useMcp` + `maxRequests` cap.

**Roo Code**: open `ModeConfig` (Zod schema, `packages/types/src/mode.ts`). 5 built-ins: `architect, code, ask, debug, orchestrator`. Each declares `groups: GroupEntry[]` where `GroupEntry = ToolGroup | [ToolGroup, {fileRegex, description}]`. Tool groups: `read/edit/command/mcp/modes` (`src/shared/tools.ts`).

File-regex enforcement (`src/core/tools/validateToolUse.ts`): edit fails → `throw new FileRestrictionError(mode, pattern, description, filePath, tool)`. Custom modes via YAML (`.roomodes` project / `~/.roo/custom_modes.yaml` global); whole-record override semantics.

`switch_mode` is in always-available `modes` group → LLM can self-switch. Bodhi-pi should NOT expose this to LLM by default (self-elevation risk).

### Continue, Aider, OpenHands

[Full notes](notes/08-continue-aider-openhands.md).

**Continue**: `ToolPolicy = "allowedWithoutPermission" | "allowedWithPermission" | "disabled"`. Context-aware narrowing (`core/tools/policies/fileAccess.ts`): `if (!isWithinWorkspace) return "allowedWithPermission"`. Worth copying — workspace predicate is host-agnostic.

**Aider**: four modes via Coder subclass. Edit gating: `Coder.allowed_to_edit()` requires `full_path in self.abs_fnames` (file must be added to chat). `--yes-always` (blanket), `--auto-accept-architect` (per-flow) — orthogonal knobs. Architect mode is opt-out child inheritance (parent disables `suggest_shell_commands` on child).

**OpenHands**: three orthogonal axes: `(SecurityAnalyzer, ConfirmationPolicy, Runtime)`. The standout: `LLMSecurityAnalyzer` injects a required `security_risk` parameter into every tool schema — LLM self-annotates risk during the same generation call. Zero extra API cost; host-agnostic. Strong candidate for bodhi-pi v3 behind a model-capability flag.

### Goose + Qwen Code

[Full notes](notes/09-goose-qwen.md).

**Goose**: `GooseMode = Auto | SmartApprove | Approve | Chat`. `SmartApprove` uses an LLM classifier (`permission_judge.rs`) with a `ToolPermissionStore` cache to judge read-only-ness. Per-tool `PermissionLevel = AlwaysAllow | AskBefore | NeverAllow`. **No sub-agent inheritance** (`subagent_handler.rs` rebuilds `AgentConfig` from scratch).

**Qwen Code** (gemini-cli fork): `ApprovalMode = PLAN | DEFAULT | AUTO_EDIT | YOLO`. `setApprovalMode` enforces folder-trust gate; PLAN snapshots `prePlanMode` for restore.

The Qwen sub-agent rule (`packages/core/src/tools/agent/agent.ts:162-194`) — `resolveSubagentApprovalMode` — is the cleanest formal model in the survey:

```ts
if (parent === YOLO || parent === AUTO_EDIT) return parent;           // permissive parent wins
if (agentApprovalMode) {
  const resolved = approvalModeToPermissionMode(agentApprovalMode);
  if (!isTrustedFolder && (resolved === Yolo || resolved === AutoEdit))
    return parent;                                                    // demote in untrusted folder
  return resolved;
}
if (parent === PLAN)   return Plan;                                   // PLAN sticks downward
if (isTrustedFolder)   return AutoEdit;
return parent;
```

`createApprovalModeOverride` (lines 245-255) isolates child config via `Object.create(base)` + tool-registry rebind + read-cache reset. Critical: without this, parent's `prior_read` cache could silently authorize subagent writes on never-read paths.

`fork-subagent.ts` uses `AsyncLocalStorage` to reject nested fork-from-fork (bodhi-pi already has `SUBAGENT_MAX_DEPTH = 2`).

### Plannotator

[Full notes](notes/11-plannotator.md).

Multi-harness companion. The `apps/pi-extension/index.ts` (1293 LOC) implements plan-mode entirely on the pi-coding-agent extension API. Phase machine `idle | planning | executing`. Mechanism:

1. **CLI flag** `pi.registerFlag("plan")` — bodhi-pi replaces with settings + wire method
2. **Slash + shortcut** for toggle
3. **Tool-set swap on phase change** via `pi.setActiveTools(...)` — bodhi-pi GAP
4. **Write gate** via `pi.on("tool_call", ...)` returning `{ block: true, reason: "..." }` — bodhi-pi has this primitive
5. **System-prompt injection** via `before_agent_start` — bodhi-pi has this
6. **`plannotator_submit_plan` tool** with browser UI for review — bodhi-pi can ship as extension
7. **Phase persistence** via `pi.appendEntry` — bodhi-pi has this

**Critical finding**: 80% of plannotator's plan-mode can be implemented as a bodhi-pi extension today. The missing 20% is `setActiveTools` for tool-cost-aware swap.

### Framework-level libraries

[Full notes](notes/10-frameworks.md).

Most have abandoned mode enums for either per-call hooks (`requires_approval`, filters, middleware) or pause-state machines (LangGraph's `interrupt()` + checkpointer). Only AutoGen v0.2 ships a true per-agent mode enum, and AutoGen itself moved away from it in v0.4.

LangGraph's `interrupt()` is the canonical resumable-exception primitive. PydanticAI's `DeferredToolRequests` output-type pattern is interesting for stateless HTTP hosts. Agno's `is_paused` + `continue_run()` is a clean stateful-pause API.

**Lesson for bodhi-pi**: pick the small-enum-on-session-level approach (AutoGen-style); ACP already covers the pause-state mechanics — bodhi-pi doesn't need a graph runtime.

---

## Mode interaction with sub-agents

The companion sub-agents report establishes that bodhi-pi already supports `SubagentProfile` (markdown / built-in / extension-registered), forked-context children, durable child sessions, and ACP lifecycle events for `subagent_start`/`subagent_end`. The mode system layers on top.

### What the surveyed harnesses do

| Harness | Inheritance rule |
|---|---|
| **cc** | Parent overrides child if parent is `bypassPermissions/acceptEdits/auto`; otherwise child profile's `permissionMode` wins. Async agents get `shouldAvoidPermissionPrompts: true`. CLI-flag-spawned children pass parent mode as `--permission-mode`. |
| **opencode** | `deriveSubagentSessionPermission`: parent's `edit:deny` rules + `external_directory` + denies flow through. PLAN-mode parent floors children. |
| **Qwen Code** | `resolveSubagentApprovalMode`: permissive-parent-wins, PLAN-parent-sticky, privileged-modes-quarantined-to-trusted-folders. Most formal rule. |
| **Codex** | Child inherits parent `Config` verbatim. Too permissive for profile-based bodhi-pi. |
| **gemini-cli** | Local executor inherits parent's approval mode, sandbox, MessageBus. Remote A2A agents are sovereign (own mode). |
| **Goose** | NO inheritance — fragile. |
| **OpenHands** | Delegate publishes to shared EventStream; inherits Conversation-level `(SecurityAnalyzer, ConfirmationPolicy)`. |

### Recommended rule for bodhi-pi

Adopt the Qwen rule with a bodhi-pi twist (replace "trusted folder" with "host capability + project setting" because bodhi-pi runs in browser/Chrome-ext where the "folder trust" concept doesn't translate):

```ts
function resolveChildMode(
  parent: AgentMode,
  profile: SubagentProfile,
  allowsAllowAll: boolean,
): AgentMode {
  // 1. Permissive parent wins
  if (parent === "allow-all" || parent === "edit") return parent;

  // 2. Profile-declared mode applies, but `allow-all` requires capability
  if (profile.mode) {
    if (profile.mode === "allow-all" && !allowsAllowAll) return parent;
    return profile.mode;
  }

  // 3. PLAN parent sticks
  if (parent === "plan") return "plan";

  // 4. Default: child inherits parent
  return parent;
}
```

Implications:
- `plan` mode parent → all children locked to `plan` (no edit/exec escape).
- `ask` mode parent → child inherits unless profile narrows to `plan` (explorer profile is always `plan`).
- `edit` / `allow-all` parent → child can't be more restrictive than parent (this is intentional — explorer profile in YOLO parent shouldn't pretend to be safe; user already opted in).
- A `SubagentProfile` declaring `mode: "allow-all"` requires `allowsAllowAllMode` at the host capability layer.

### Per-tool override propagation

Bodhi-pi `SubagentProfile.tools` allowlist already narrows the child's tool set. Layer the permission policy on top:
- Child's `permissionPolicy` = `mergePolicy(parent.permissionPolicy, profile.permissionPolicy?, modeDefaults[childMode])`
- Parent's `deny` rules propagate (cc + opencode pattern); child can't escalate to `allow`
- Profile's per-tool `deny` adds to child's policy
- Profile's per-tool `allow` is permitted only for tools the parent already allows or asks

### Approval bubbling

When a child sub-agent's tool call triggers approval, the request surfaces on the **parent session's** wire (since the child session is typically headless from the user's perspective). Implementation: `tool_approval_request` lifecycle event carries `parentSessionId` + `childSessionId`; UI shows "the explorer subagent wants to run bash:rm -rf node_modules — allow?". Hosts can choose to render child approvals inline within the parent's transcript view.

---

## Design recommendations for Bodhi-Pi

### Headline architecture

```
┌────────────────────────────────────────────────────────────────┐
│  USER-FACING:  AgentMode = "ask" | "plan" | "edit" | "allow-all" │
│                (small enum; lifecycle event on change)         │
└────────────────────────────────────────────────────────────────┘
            │
            │  Each mode is a PRESET over PermissionPolicy.
            │  User/profile can override per-tool.
            ▼
┌────────────────────────────────────────────────────────────────┐
│  STRUCTURED:   PermissionPolicy = {                             │
│                  categories: { read, edit, search, execute, mcp, subagent }, │
│                  tools:      { [toolName]: PermissionDecision },           │
│                  alwaysAllow: AllowPattern[],                              │
│                  alwaysDeny:  DenyPattern[],                               │
│                  sessionGrants: ToolName[]                                 │
│                }                                                            │
│                PermissionDecision = "allow" | "ask" | "deny"               │
└────────────────────────────────────────────────────────────────┘
            │
            │  Resolution: alwaysDeny → tool override → session grant
            │              → category → mode preset default
            ▼
┌────────────────────────────────────────────────────────────────┐
│  ENFORCEMENT LAYERS (defence in depth)                          │
│                                                                │
│  1. (v2) Tool-registry filter — denied tools removed from      │
│     model-visible tool list                                    │
│  2. Pre-call policy check in built-in PermissionService        │
│     (consumes ToolCallEvent + ToolCallEventResult.block)       │
│  3. Approval round-trip — wire methods                         │
│     _bodhi-pi/permission/request ↔ /respond                    │
│  4. SUB-AGENT inheritance (Qwen rule) in SubagentService.spawn │
└────────────────────────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────────────┐
│  SUPPORT SURFACES                                              │
│  • Lifecycle events on both rails:                             │
│      in-process EventDispatcher + LIFECYCLE_EVENT_METHOD wire  │
│  • mode_change, tool_approval_request, tool_approval_response  │
│  • Status surface via _bodhi-pi/session/config (mode field)    │
│  • Persistence:                                                │
│      session — SessionState (in-memory + session_settings)     │
│      project — .bodhi-pi/settings.json defaultMode             │
│      global  — ~/.bodhi-pi/settings.json defaultMode           │
└────────────────────────────────────────────────────────────────┘
```

### Cross-runtime considerations

| Runtime | Mode story | Approval story | Sandbox story |
|---|---|---|---|
| **CLI** (`test-apps/cli`) | wire method + slash command + (optional) keybinding host-side | wire request → CLI prompt | Host wraps `Filesystem`/`Terminal` with path scoping; can layer Seatbelt/Landlock on top |
| **HTTP per-turn-rebuild** (`test-apps/http`) | mode persisted in `SessionStore`; rebuilt on each turn | wire request → response in JSON body OR deferred-tool pattern (return pending requests, accept resolutions on next turn) | Host wraps adapters; multi-tenant isolation via per-userId scopes |
| **Browser worker** (`test-apps/browser`) | wire method via MessagePort + UI button | wire request → in-page modal | Host wraps `Filesystem` (ZenFS/FSA) with path scoping; no OS sandbox available |
| **Chrome-ext MV3** (`test-apps/chrome-ext`) | same as browser | wire request → extension popup or content-script modal | same as browser; chrome.permissions for additional gating |

The mode and approval surface is **identical** across runtimes — bodhi-pi core doesn't know whether the approval prompt is rendered as a CLI question, JSON deferred response, in-page modal, or extension popup. Hosts implement their own UI.

### What to skip / defer

- **OS-level sandbox in core**: skip. Document as host responsibility. Provide settings key `sandbox.allowedPaths: string[]` that hosts can read.
- **LLM classifier mode (`auto`/`smart_approve`)**: defer to v3+. High infra cost for marginal gain over per-category defaults.
- **LLM `security_risk` field injection**: prototype in v3 behind model-capability flag.
- **Mid-session model-as-mode-changer** (mastracode's `defaultModelId` per mode): defer to v2. v1 mode change does NOT change model; user can change model independently via existing `_bodhi-pi/session/setSessionConfigOption`.
- **Mode markdown discovery** (opencode/Roo style): defer to v3. v1 ships 4 hardcoded modes; v2 adds profile-style overrides; v3 considers user-defined modes.
- **`switch_mode` LLM tool**: do NOT expose to LLM. Mode change is user-initiated only. Self-elevation risk.
- **Mode change without lifecycle event**: never. Every change must emit `mode_change` on both rails.

---

## Proposed Bodhi-Pi interfaces

These are sketches; final names and types will land via the implementation plan's per-commit spec updates.

```ts
// src/sessions/mode.ts (new)

export type AgentMode = "ask" | "plan" | "edit" | "allow-all";

export const ALL_AGENT_MODES: readonly AgentMode[] = [
  "ask", "plan", "edit", "allow-all",
] as const;

// Permissiveness lattice (most-restrictive → most-permissive)
export const MODES_BY_PERMISSIVENESS: readonly AgentMode[] = [
  "plan", "ask", "edit", "allow-all",
] as const;
```

```ts
// src/permissions/types.ts (new)

export type PermissionDecision = "allow" | "ask" | "deny";

/** Tool categories track bodhi-pi's existing toolKindFor classification, plus mcp + subagent. */
export type ToolCategory = "read" | "edit" | "search" | "execute" | "mcp" | "subagent" | "other";

/**
 * A pattern matches against `<toolName>` or `<toolName>:<argFingerprint>`.
 * v1 supports only `<toolName>` and `<toolName>:*`. v2 adds argument patterns
 * (e.g. `bash:npm test`, `edit:*.md`).
 */
export type PermissionPattern = string;

export interface PermissionPolicy {
  /** Per-category default decision; mode preset populates this. */
  categories: Partial<Record<ToolCategory, PermissionDecision>>;
  /** Per-tool override; takes priority over category. Key is tool name. */
  tools: Record<string, PermissionDecision>;
  /** Persistent always-allow patterns; matched before everything. */
  alwaysAllow: PermissionPattern[];
  /** Persistent always-deny patterns; matched first (cannot be overridden in-session). */
  alwaysDeny: PermissionPattern[];
}

export interface SessionGrants {
  /** In-memory only; cleared on session shutdown. */
  toolNames: Set<string>;
  categories: Set<ToolCategory>;
}

/** Bodhi-pi mode → default policy. Built-in v1 presets. */
export interface ModePreset {
  mode: AgentMode;
  description: string;
  policy: PermissionPolicy;
  systemPromptSuffix?: string;
}
```

```ts
// src/permissions/runtime-capabilities.ts (new)

export interface ModeRuntimeCapabilities {
  /** Host-injected on init. When false, _bodhi-pi/mode/set with "allow-all" rejects with -32603. */
  allowsAllowAllMode: boolean;
  /** Host-injected on init. Per-Host opt-in for persisting "allow-all" as a project default. */
  allowsAllowAllModeAsProjectDefault: boolean;
  /** Sandbox declaration — host's Filesystem/Terminal MAY scope to these. Bodhi-pi doesn't enforce. */
  sandboxAllowedPaths?: string[];
}
```

```ts
// src/permissions/approval-protocol.ts (new)

export interface ApprovalRequest {
  /** Unique correlation ID for matching request → response. */
  correlationId: string;
  /** The parent session ID (where approval surfaces). */
  parentSessionId: string;
  /** The session that actually triggered the request (parent or sub-agent child). */
  originSessionId: string;
  toolCallId: string;
  toolName: string;
  category: ToolCategory;
  /** Display-ready arg fingerprint, e.g. "bash:npm test" or "edit:src/foo.ts". */
  argFingerprint: string;
  /** Raw arg payload — UI can pretty-print or show diff. */
  rawArgs: unknown;
  /** Reason from the policy (e.g. "policy.categories.execute = ask"). */
  reason: string;
}

export type ApprovalResponse =
  | { decision: "allow_once"; correlationId: string }
  | { decision: "allow_always"; correlationId: string; pattern: PermissionPattern; scope: "session" | "project" | "global" }
  | { decision: "deny"; correlationId: string }
  | { decision: "deny_always"; correlationId: string; pattern: PermissionPattern; scope: "session" | "project" | "global" }
  | { decision: "modify_and_allow_once"; correlationId: string; modifiedArgs: unknown };

export type ToolPermissionOutcome =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "pending"; approvalRequest: ApprovalRequest };

export interface ToolPermissionDecision {
  outcome: ToolPermissionOutcome;
  matchedRule: {
    source: "alwaysDeny" | "alwaysAllow" | "sessionGrant" | "toolOverride" | "categoryDefault" | "modePreset";
    pattern?: PermissionPattern;
  };
}
```

```ts
// src/subagents/types.ts (extension)

export interface SubagentProfile {
  // ... existing fields ...
  /**
   * Optional mode override for this profile. Subject to Qwen-rule resolution:
   * permissive-parent-wins, PLAN-parent-sticky, allow-all requires capability.
   */
  mode?: AgentMode;
  /** Profile-scoped permission overrides; layered on top of inherited parent policy. */
  permissionOverrides?: Partial<PermissionPolicy>;
}

export function resolveChildMode(
  parent: AgentMode,
  profile: SubagentProfile,
  capabilities: ModeRuntimeCapabilities,
): AgentMode {
  if (parent === "allow-all" || parent === "edit") return parent;
  if (profile.mode) {
    if (profile.mode === "allow-all" && !capabilities.allowsAllowAllMode) return parent;
    return profile.mode;
  }
  if (parent === "plan") return "plan";
  return parent;
}
```

```ts
// src/extensions/types.ts (extension — v2 addition)

export interface ExtensionAPI {
  // ... existing methods ...
  /**
   * v2: Replace the active LLM-visible tool list for this session.
   * Returns the previous list so extensions can restore on phase exit.
   * Mode-change triggers an implicit setActiveTools.
   */
  setActiveTools(sessionId: string, toolNames: string[]): Promise<string[]>;
  getActiveTools(sessionId: string): string[];
}
```

```ts
// src/wire/constants.ts (extension)

/** Set the active mode for the session. Emits mode_change lifecycle event. */
export const EXT_MODE_SET = "_bodhi-pi/mode/set";

/** Get the current mode + resolved policy. */
export const EXT_MODE_GET = "_bodhi-pi/mode/get";

/** List available modes with their preset descriptions. */
export const EXT_MODE_LIST = "_bodhi-pi/mode/list";

/** Respond to a pending approval request. */
export const EXT_PERMISSION_RESPOND = "_bodhi-pi/permission/respond";

/** List in-flight approval requests for a session (host UI refresh after reconnect). */
export const EXT_PERMISSION_LIST = "_bodhi-pi/permission/list";

/** Read effective permission policy (resolved across global/project/session). */
export const EXT_PERMISSION_POLICY_GET = "_bodhi-pi/permission/policy/get";

/** Write a permission rule at a specific scope (session/project/global). */
export const EXT_PERMISSION_POLICY_SET = "_bodhi-pi/permission/policy/set";
```

```ts
// src/events/types.ts (extension)

export interface ModeChangeEvent {
  type: "mode_change";
  sessionId: string;
  fromMode: AgentMode | null;
  toMode: AgentMode;
  reason: "user" | "submit_plan_approved" | "session_load" | "extension";
}

export interface ToolApprovalRequestEvent {
  type: "tool_approval_request";
  sessionId: string;
  request: ApprovalRequest;
}

export interface ToolApprovalResponseEvent {
  type: "tool_approval_response";
  sessionId: string;
  correlationId: string;
  decision: ApprovalResponse["decision"];
}
```

---

## Implementation plan

Bodhi-pi uses trunk-based development with per-commit spec updates and the four-Host runtime parity rule. Each phase below is one (or a tight sequence of) commits, each individually green across `npm run check`, `npm test`, `just test-e2e`, and `just test-e2e-ui`. The 6-step TDD workflow (src test → e2e gpt-4o-mini → node-adapter → browser → cli/browser/chrome-ext e2e → http integration) applies per feature.

### Phase 1 — `ask` and `plan` (foundation)

**v1.0 — Core mode enum + ask-mode call-time policy**
- Add `AgentMode` type, `MODES_BY_PERMISSIVENESS`, `ModePreset` for `ask` and `plan` only (v1.1 adds edit/allow-all).
- `PermissionPolicy` types; per-category resolution; mode-preset registry.
- `PermissionService` in `src/permissions/` — consumes `ToolCallEvent`, returns block + reason for `deny`, asks user for `ask`, allows for `allow`.
- Wire `_bodhi-pi/mode/set`, `/get`, `/list` and `_bodhi-pi/permission/respond`, `/list`, `/policy/{get,set}`.
- `mode_change` + `tool_approval_request` + `tool_approval_response` lifecycle events on both rails.
- Default mode: `edit` (compatible with current `main` behaviour — write tools auto-run; this is reframed as `edit` mode being default).
- Settings key `defaultMode` at global/project/session scope.
- Test matrix: 6-step TDD per Host; e2e asserts mode change triggers expected tool denials.

**v1.1 — `plan` mode prompt + write-block**
- Add `plan` mode preset: `{read: allow, search: allow, edit: deny, execute: deny, mcp: deny, subagent: deny}`.
- Plan-mode `systemPromptSuffix` shipped in `src/permissions/presets/plan.ts`.
- v1's call-time `block` enforcement (model still sees write tools, calls are rejected with a planner-redirect message).
- Add optional built-in `submit_plan` tool (registered only when extension or host opts in via config) that auto-transitions to `edit` mode on user approval.

### Phase 2 — `edit` and `allow-all`

**v2.0 — `edit` mode preset**
- Add `edit` mode preset: `{read: allow, search: allow, edit: allow, execute: ask, mcp: ask, subagent: ask}`.
- Per-tool `respectsEditMode` flag on built-in tool definitions (write/edit have it; bash/run_script don't).
- Approval-request flow battle-tested across all four Hosts.

**v2.1 — `allow-all` mode preset + capability gate**
- Add `allow-all` mode preset: all categories `allow`.
- Host capability `allowsAllowAllMode: boolean` on `BodhiPiConfig` (default `false`; cli sets `true`; http sets `false` unless explicit opt-in; browser/chrome-ext default `false`).
- `_bodhi-pi/mode/set { mode: "allow-all" }` rejects with `-32603` if capability false.
- Project-default persistence requires separate `allowsAllowAllModeAsProjectDefault` capability + `dangerouslyAllowAllowAllModeAsDefault: true` setting flag (two-key safety net mirroring cc's `--allow-dangerously-skip-permissions` + `--dangerously-skip-permissions`).
- Strip safety-immune rules (path patterns like `.git/`, KV secrets) that `allow-all` cannot bypass.

### Phase 3 — Sub-agent inheritance

**v3.0 — `resolveChildMode` rule + profile mode override**
- Add `SubagentProfile.mode?: AgentMode` and `permissionOverrides?: Partial<PermissionPolicy>` fields.
- Implement `resolveChildMode` (Qwen rule) in `SubagentService.spawn`.
- Update built-in `explore` profile: `mode: "plan"` (always read-only regardless of parent).
- Built-in `planner` profile: `mode: "plan"`.
- Audit `SubagentService.spawn` for shared `Filesystem` state (read-cache leak risk — Qwen's lesson). Verify per-session scoping or add it.
- Sub-agent approval requests bubble to parent session (lifecycle event carries `originSessionId` + `parentSessionId`).

### Phase 4 — Active tool-set swap + persistent rules

**v4.0 — `ExtensionAPI.setActiveTools()`**
- Add the API. On change, rebuild `piAgent.state.tools` via the same merge code MCP already uses.
- Mode change emits an implicit `setActiveTools` if the new mode's tool allowlist differs from current.
- LLM no longer sees disabled tools — reduces blocked-call confusion and token cost.

**v4.1 — Persistent allow/deny patterns**
- `_bodhi-pi/permission/policy/set` accepts `scope: "session" | "project" | "global"` + `pattern` + `decision`.
- Patterns stored as `alwaysAllow: PermissionPattern[]` and `alwaysDeny: PermissionPattern[]`.
- "Always" reply on approval prompt adds to `session` scope by default; UI can prompt for higher scope.
- Resolution: `alwaysDeny` > `alwaysAllow` > tool override > session grant > category > mode preset.

### Phase 5 — MCP and extension integration

**v5.0 — MCP per-server policy**
- MCP tools default to parent session's mode; per-MCP-server override possible via setting key `mcp.<slug>.permission`.
- MCP elicitation gating (Codex pattern): in `allow-all` mode, MCP elicitations still surface (these are user-facing prompts the MCP server WANTS the user to see).
- In `ask` mode, MCP tool calls all require approval unless server is explicitly trusted.

**v5.1 — Extension permission contributions**
- Extensions can register a `permissionPolicyContributor` callback that receives the in-flight tool call and returns an additional rule.
- Multiple contributors compose; first-deny wins (extensions can only tighten, not loosen).

### Phase 6 — Polish, advanced features

**v6.0 — `argFingerprint` patterns**
- Patterns can match `<toolName>:<argFingerprint>` (e.g. `bash:npm test`, `edit:*.md`).
- Per-tool fingerprint computation (each tool defines `fingerprint(args): string`).

**v6.1 — LLM self-annotated risk (OpenHands pattern)**
- Behind a model-capability flag, inject `security_risk: enum` field into every tool schema.
- Policy can act on the LLM-self-reported risk (e.g. `ask` mode auto-approves `LOW`, prompts on `MEDIUM`, prompts with warning on `HIGH`).
- Defer until clear use case + model-coverage testing.

**v6.2 — Mode markdown discovery (user-defined modes)**
- `<cwd>/.bodhi-pi/modes/<slug>.md` discovery mirroring `SubagentProfile`.
- YAML frontmatter: `name`, `description`, `policy`, `systemPromptSuffix`.
- Project-discoverable + extension-registered + built-in merge (built-in lowest precedence).

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Prompt-only enforcement bypass** — LLM ignores planner prompt in plan mode and tries to call `write`. | Defence-in-depth: built-in `PermissionService` blocks at call time even if the LLM is confused; v2+ removes write tools from the model-visible registry entirely. Test with adversarial prompts (the existing `*-llm-invocation.test.ts` pattern from sub-agents work applies). |
| **Browser runtime limitations** — no OS sandbox, can't sandbox-exec, FSA scoping is per-host-discretion. | Document explicitly: bodhi-pi modes declare *intent*; **host's `Filesystem`/`Terminal` adapter** enforces. Provide a settings key `sandbox.allowedPaths` for hosts to consume. Browser host's ZenFS already restricts to mounted directory; chrome-ext has its own permission model. Do NOT promise OS-sandbox equivalence in non-Node hosts. |
| **Chrome-ext MV3 security model** — service worker has limited persistence; sandbox iframe required for unsafe-eval. | Modes ride existing MV3 plumbing (KV in `chrome.storage`, wire over MessagePort). The unsafe-eval sandbox iframe (for script execution) is orthogonal to mode policy; modes can deny `execute` category to prevent its invocation entirely. |
| **MCP tool risks** — MCP servers can be malicious; tools can have arbitrary names and side effects. | MCP tools follow parent mode by default but with conservative `ask` defaults for `mcp__*` patterns. Per-server policy override. Document: trust boundary at MCP server connection (user explicitly added the server). MCP server's own elicitations always surface (user is the agent for the MCP server, not the LLM). |
| **Shell execution in `allow-all` mode** — `rm -rf /`, network exfil. | Host capability gate (`allowsAllowAllMode`) prevents browser/chrome-ext from ever entering. Node CLI host SHOULD layer a Seatbelt/Landlock wrapper around its `Terminal` adapter for `allow-all` mode (template in `test-apps/node-adapters`). Settings flag `dangerouslyAllowAllowAllModeAsDefault` is two-step (capability AND setting). |
| **File-write risks in `edit` mode** — agent edits files outside intended scope. | Mode declares intent; `Filesystem` adapter enforces scope. Continue's `evaluateFileAccessPolicy(basePolicy, isWithinWorkspace)` pattern: out-of-workspace writes are forced to `ask` regardless of mode. Adopt in v2 — bodhi-pi knows `cwd`. |
| **Git worktree / repo destruction** in any mode. | cc's bypass-immune safety paths (`.git/`, shell config files, `.claude/`) are a great precedent. Bodhi-pi: ship a hardcoded `alwaysDeny` list covering `.git/**` (writes), `.bodhi-pi/**` (writes), `.env*` (reads), `~/.ssh/**` (reads). User can override globally via setting but it requires explicit opt-out, not a mode toggle. |
| **`allow-all` mid-session abuse** — user toggles to `allow-all`, walks away, agent rampages. | cc's Statsig kill-switch pattern: hosts can implement a "max consecutive auto-approved calls" cap that auto-downgrades to `ask` (Cline's `maxRequests`). Expose via setting `allowAll.maxConsecutiveCalls?: number`. |
| **Sub-agent privilege escalation** — child profile asks for `allow-all` when parent is `ask`. | Qwen rule: profile mode is honoured only if equal-or-more-restrictive than parent. `allow-all` profile in `ask`-parent → demoted to parent's mode. Test with `*-llm-invocation.test.ts` per sub-agent. |
| **Approval flooding** — too many prompts make user click through without reading. | Adopt mastracode's category/session grant tier — "always allow `edit` for this session" reduces fatigue. Adopt Cline's `maxRequests` cap. Display approval batches when consecutive same-category requests arrive. |
| **Mid-session mode-change race** — user toggles mode while LLM has in-flight tool call. | Mode change is async; pending tool calls evaluated against the mode at call time. If mode tightened, in-flight `ask` becomes `deny`. Add `mode_change` event ordering test. |
| **Persisted mode vs session-loaded state** — mismatch on rehydrate. | Session bootstrap reads `defaultMode` from effective settings; explicit session-scope `mode` setting overrides. `session_load` event carries the resolved mode. Test load/resume parity. |
| **Extension-registered modes (v6) conflict** with built-in or each other. | `validateAndNormalizeMode` shared pipeline (mirroring `_validate.ts` for sub-agents). Built-in lowest precedence; project markdown overrides extension; first-write-wins for duplicate names. |

---

## References

### Primary source — bodhi-pi

- `packages/bodhi-pi/src/acp/agent.ts` — `BodhiPiAcpAgent` + `createBodhiPiAgent`
- `packages/bodhi-pi/src/acp/prompt-loop.ts` — `runPromptLoop` + `subscribeToAgent` (ACP event forwarding)
- `packages/bodhi-pi/src/events/types.ts` — `BodhiPiEvent` discriminated union, `ToolCallEvent`, `ToolCallEventResult`
- `packages/bodhi-pi/src/extensions/types.ts` — `ExtensionAPI`, `ExtensionEventHandler`
- `packages/bodhi-pi/src/tools/index.ts` — `createBuiltinTools`, `toolKindFor`, `BUILTIN_TOOL_SNIPPETS`
- `packages/bodhi-pi/src/subagents/types.ts` — `SubagentProfile`
- `packages/bodhi-pi/src/subagents/subagent-service.ts` — `SubagentService.spawn`
- `packages/bodhi-pi/src/wire/constants.ts` — `_bodhi-pi/<area>/<verb>` method names + `LIFECYCLE_EVENT_METHOD`
- `packages/bodhi-pi/src/sessions/session-state.ts` — `SessionState`
- `packages/bodhi-pi/src/sessions/session-store.ts` — `SessionStore`, `SessionRecord`, `SessionInfo`
- `packages/bodhi-pi/CLAUDE.md` — architecture pillars (ACP-as-contract, no-silent-defaults, both-rails-lifecycle, runtime-host-parity)
- [`ai-docs/specs/bodhi-pi/subagents.md`](../../specs/bodhi-pi/subagents.md) — current sub-agents spec
- [`ai-docs/research/sub-agents/Sub-Agent Implementations in Popular Open-Source Agent Harnesses: Research Report for Bodhi-Pi.md`](../sub-agents/Sub-Agent%20Implementations%20in%20Popular%20Open-Source%20Agent%20Harnesses%3A%20Research%20Report%20for%20Bodhi-Pi.md) — companion research

### cc (claude code)

Local source: `/Users/amir36/Documents/workspace/src/github.com/anagri/cc-anaysis/src/`

- `src/types/permissions.ts:16-38` — `EXTERNAL_PERMISSION_MODES`, `INTERNAL_PERMISSION_MODES`, `PermissionMode`
- `src/utils/permissions/PermissionMode.ts:42-91` — per-mode metadata (title, symbol, color)
- `src/utils/permissions/permissions.ts:473-1319` — `hasPermissionsToUseTool` pipeline
- `src/utils/permissions/permissions.ts:1268-1281` — mode bypass logic
- `src/utils/permissions/permissions.ts:122-302` — rule helpers
- `src/utils/permissions/getNextPermissionMode.ts:34-101` — Shift+Tab cycle
- `src/utils/permissions/bypassPermissionsKillswitch.ts` — Statsig kill-switch
- `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:77-102` — enter plan mode
- `src/tools/EnterPlanModeTool/ExitPlanModeV2Tool.ts:243-403` — exit plan mode with approval
- `src/tools/AgentTool/runAgent.ts:415-479` — sub-agent mode inheritance
- `src/tools/shared/spawnMultiAgent.ts:220-230` — mode → CLI flag for child spawn
- `src/keybindings/defaultBindings.ts:30,143` — Shift+Tab binding
- `src/main.tsx:976` — `--dangerously-skip-permissions` CLI option
- `src/setup.ts:334-437` — bypass safety gates (root/sandbox check)

### opencode

Local source: `/Users/amir36/Documents/workspace/src/github.com/anomalyco/opencode/packages/opencode/src/`

- `agent/agent.ts:28-48` — `Agent.Info` schema
- `agent/agent.ts:126-278` — built-in agent definitions (`build`, `plan`, `general`, `explore`, `scout`)
- `agent/agent.ts:142-163` — plan mode permission
- `agent/agent.ts:179-200` — explore subagent
- `agent/subagent-permissions.ts:17-34` — `deriveSubagentSessionPermission`
- `config/agent.ts:132-160` — `loadMode` markdown discovery
- `config/config.ts:620,696-703` — config merge order
- `config/permission.ts:1-59` — `Permission` schema (`Action`, `Rule`, `Object`)
- `permission/evaluate.ts:9-15` — wildcard last-match-wins
- `permission/index.ts:32-238` — `Permission.ask` flow
- `permission/index.ts:291-302` — `disabled()` helper

### MastraCode + Mastra core

Local source: `/Users/amir36/Documents/workspace/src/github.com/mastra-ai/mastra/`

- `mastracode/src/index.ts:372-395` — `defaultModes`
- `mastracode/src/index.ts:370-487` — subagent + mode map
- `mastracode/src/index.ts:506-520` — settings.json mode/yolo
- `mastracode/src/permissions.ts:15-110` — `ToolCategory`, `PermissionPolicy`, defaults, tool-category map
- `mastracode/src/permissions.ts:64-72` — `ALWAYS_ALLOW_TOOLS`
- `mastracode/src/permissions.ts:112-118` — `YOLO_POLICIES`
- `mastracode/src/permissions.ts:131-159` — `SessionGrants`
- `mastracode/src/permissions.ts:177-199` — `resolveApproval`
- `mastracode/src/schema.ts:27-34,50-51` — persisted `yolo`, `permissionRules`, `sandboxAllowedPaths`
- `mastracode/src/agents/instructions.ts:11-34` — `getDynamicInstructions`
- `mastracode/src/agents/tools.ts:18-49` — `wrapToolWithHooks`
- `mastracode/src/agents/tools.ts:104-112` — strip denied tools
- `mastracode/src/tui/setup.ts:136-158` — Shift+Tab + Ctrl+Y
- `mastracode/src/tui/components/tool-approval-dialog.ts:17-21` — `ApprovalAction`
- `packages/core/src/harness/types.ts:43-67` — `HarnessMode`
- `packages/core/src/harness/types.ts:315-333` — core `PermissionPolicy`
- `packages/core/src/harness/types.ts:269-274` — `toolCategoryResolver`
- `packages/core/src/harness/harness.ts:548-574` — `switchMode`
- `packages/core/src/harness/harness.ts:2354-2387` — `tool-call-approval` stream chunk handling
- `packages/core/src/harness/tools.ts:133-199` — `submitPlanTool`

### gemini-cli

Local source: `/Users/amir36/Documents/workspace/src/github.com/google-gemini/gemini-cli/`

- `packages/core/src/policy/types.ts:48-65` — `ApprovalMode`, `MODES_BY_PERMISSIVENESS`
- `packages/core/src/policy/types.ts:378-382` — `PRIORITY_YOLO_ALLOW_ALL`
- `packages/core/src/tools/tools.ts:47-107` — `ToolInvocation` interface
- `packages/core/src/tools/tools.ts:157-380` — `BaseToolInvocation` (`respectsAutoEdit`, `shouldConfirmExecute`)
- `packages/core/src/tools/tools.ts:277-371` — `getMessageBusDecision`
- `packages/core/src/tools/tools.ts:1094-1102` — `ToolConfirmationOutcome`
- `packages/core/src/tools/tools.ts:1104-1118` — `Kind`
- `packages/core/src/agents/local-executor.ts:120-146` — child executionContext
- `packages/core/src/agents/agent-tool.ts:40-120` — `AgentTool`
- `packages/core/src/agents/remote-invocation.ts:42-86` — `RemoteAgentInvocation`
- `packages/core/src/services/sandboxManager.ts:32-99` — `SandboxModeConfig`
- `packages/cli/src/config/config.ts:86-344` — CLI args + approval resolution
- `packages/cli/src/config/settingsSchema.ts:215-230` — settings schema

### Codex

Local source: `/Users/amir36/Documents/workspace/src/github.com/openai/codex/codex-rs/`

- `protocol/src/protocol.rs:900-931` — `AskForApproval`
- `protocol/src/protocol.rs:933-970` — `GranularApprovalConfig`
- `protocol/src/protocol.rs:991-1042` — `SandboxPolicy`
- `protocol/src/permissions.rs:187-192` — `FileSystemSandboxKind`
- `core/src/exec_policy.rs:175-198` — approval mode behaviour matrix
- `core/src/exec_policy.rs:272-379` — decision combinator
- `core/src/exec_policy.rs:335-355` — Prompt → policy resolution
- `core/src/exec_policy.rs:632-750` — unmatched command fallback
- `core/src/exec_policy.rs:654-660` — Windows ReadOnly fallback
- `core/src/thread_manager.rs:612-638` — `spawn_subagent`
- `core/src/mcp_tool_call.rs:168,211,627-634,650-673` — MCP elicitation gating
- `core/src/tools/network_approval.rs:42-84` — `NetworkApprovalMode`
- `sandboxing/src/seatbelt.rs` — macOS Seatbelt
- `cli/src/main.rs:1702-1711,2377-2387` — CLI flags + conflict detection
- `tui/src/bottom_pane/status_line_setup.rs:88-92` — status-line `ApprovalMode` item
- `config/src/config_toml.rs:160,186` — `approval_policy`, `sandbox_mode`

### Cline

GitHub:
- [`src/shared/tools.ts`](https://github.com/cline/cline/blob/main/src/shared/tools.ts)
- [`src/shared/AutoApprovalSettings.ts`](https://github.com/cline/cline/blob/main/src/shared/AutoApprovalSettings.ts)
- [`src/shared/ExtensionMessage.ts`](https://github.com/cline/cline/blob/main/src/shared/ExtensionMessage.ts)
- [`src/core/task/index.ts`](https://github.com/cline/cline/blob/main/src/core/task/index.ts)
- [`src/core/task/ToolExecutor.ts`](https://github.com/cline/cline/blob/main/src/core/task/ToolExecutor.ts)
- [Plan and Act Modes on DeepWiki](https://deepwiki.com/cline/cline/3.4-plan-and-act-modes)

### Roo Code

GitHub:
- [`packages/types/src/mode.ts`](https://github.com/RooCodeInc/Roo-Code/blob/main/packages/types/src/mode.ts)
- [`packages/types/src/roomodes-schema.ts`](https://github.com/RooCodeInc/Roo-Code/blob/main/packages/types/src/roomodes-schema.ts)
- [`src/shared/modes.ts`](https://github.com/RooCodeInc/Roo-Code/blob/main/src/shared/modes.ts)
- [`src/shared/tools.ts`](https://github.com/RooCodeInc/Roo-Code/blob/main/src/shared/tools.ts)
- [`src/core/tools/validateToolUse.ts`](https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/tools/validateToolUse.ts)
- [Using Modes (docs)](https://docs.roocode.com/basic-usage/using-modes)
- [Custom Modes (docs)](https://docs.roocode.com/features/custom-modes)

### Continue

GitHub:
- [`core/tools/policies/fileAccess.ts`](https://github.com/continuedev/continue/blob/main/core/tools/policies/fileAccess.ts)
- [`core/tools/applyToolOverrides.ts`](https://github.com/continuedev/continue/blob/main/core/tools/applyToolOverrides.ts)
- [`core/tools/builtIn.ts`](https://github.com/continuedev/continue/blob/main/core/tools/builtIn.ts)
- [How Agent Mode Works (docs)](https://docs.continue.dev/ide-extensions/agent/how-it-works)
- [config.yaml Reference](https://docs.continue.dev/reference)

### Aider

GitHub:
- [`aider/coders/base_coder.py`](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py)
- [`aider/coders/architect_coder.py`](https://github.com/Aider-AI/aider/blob/main/aider/coders/architect_coder.py)
- [`aider/coders/ask_coder.py`](https://github.com/Aider-AI/aider/blob/main/aider/coders/ask_coder.py)
- [`aider/main.py`](https://github.com/Aider-AI/aider/blob/main/aider/main.py)
- [Chat Modes (docs)](https://aider.chat/docs/usage/modes.html)
- [Options reference](https://aider.chat/docs/config/options.html)
- [Separating Code Reasoning and Editing](https://aider.chat/2024/09/26/architect.html)

### OpenHands

GitHub:
- [`openhands/sdk/security/confirmation_policy.py`](https://github.com/All-Hands-AI/OpenHands/tree/main/openhands/sdk/security)
- [`openhands/sdk/security/` (analyzer base)](https://github.com/All-Hands-AI/OpenHands/tree/main/openhands/sdk/security)
- [`openhands/security/` (V0 legacy)](https://github.com/All-Hands-AI/OpenHands/tree/main/openhands/security)
- [`openhands/runtime/`](https://github.com/All-Hands-AI/OpenHands/tree/main/openhands/runtime)
- [`openhands/controller/agent_controller.py`](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/controller/agent_controller.py)
- [Security & Action Confirmation (docs)](https://docs.openhands.dev/sdk/guides/security)
- [OpenHands SDK paper](https://arxiv.org/html/2511.03690v1)

### Goose

GitHub (`block/goose`):
- [`crates/goose/src/config/goose_mode.rs`](https://github.com/block/goose/blob/main/crates/goose/src/config/goose_mode.rs)
- [`crates/goose/src/permission/permission_inspector.rs`](https://github.com/block/goose/blob/main/crates/goose/src/permission/permission_inspector.rs)
- [`crates/goose/src/permission/permission_judge.rs`](https://github.com/block/goose/blob/main/crates/goose/src/permission/permission_judge.rs)
- [`crates/goose/src/permission/permission_confirmation.rs`](https://github.com/block/goose/blob/main/crates/goose/src/permission/permission_confirmation.rs)
- [`crates/goose/src/permission/permission_store.rs`](https://github.com/block/goose/blob/main/crates/goose/src/permission/permission_store.rs)
- [`crates/goose/src/agents/tool_confirmation_router.rs`](https://github.com/block/goose/blob/main/crates/goose/src/agents/tool_confirmation_router.rs)
- [`crates/goose/src/agents/subagent_handler.rs`](https://github.com/block/goose/blob/main/crates/goose/src/agents/subagent_handler.rs)
- [Tool Permissions (docs)](https://block.github.io/goose/docs/guides/tool-permissions/)

### Qwen Code

GitHub (`QwenLM/qwen-code`):
- [`packages/core/src/config/config.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/config/config.ts) — `ApprovalMode`
- [`packages/core/src/tools/agent/agent.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/tools/agent/agent.ts) — `resolveSubagentApprovalMode`, `createApprovalModeOverride`, `rebuildToolRegistryOnOverride`
- [`packages/core/src/tools/agent/fork-subagent.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/tools/agent/fork-subagent.ts)
- [`packages/core/src/subagents/subagent-manager.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/subagents/subagent-manager.ts)
- [`packages/core/src/agents/runtime/agent-core.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/agents/runtime/agent-core.ts)
- [Sub-agents (docs)](https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/)

### Plannotator

Local source: `/Users/amir36/Documents/workspace/src/github.com/backnotprop/plannotator/`

- `apps/pi-extension/index.ts` — full plan/execute extension (1293 LOC)
- `apps/pi-extension/tool-scope.ts` — `Phase`, `getToolsForPhase`, `isPlanWritePathAllowed`
- `apps/pi-extension/config.ts`, `plannotator-events.ts`, `assistant-message.ts`
- `apps/opencode-plugin/plan-mode.ts` — opencode permission ruleset override
- `apps/codex/README.md`, `apps/gemini/{commands,hooks}/`, `apps/copilot/`

### Framework-level

- LangGraph: [`libs/langgraph/langgraph/types.py`](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/types.py), [Interrupts docs](https://docs.langchain.com/oss/python/langgraph/interrupts), [Static breakpoints](https://langchain-ai.github.io/langgraph/cloud/how-tos/human_in_the_loop_breakpoint/)
- AutoGen: [v0.2 `conversable_agent.py`](https://github.com/microsoft/autogen/blob/0.2/autogen/agentchat/conversable_agent.py), [v0.4 `UserProxyAgent`](https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/agents/_user_proxy_agent.py)
- DeepAgents: [`SubAgentMiddleware`](https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/deepagents/middleware/subagents.py), [`HumanInTheLoopMiddleware` reference](https://reference.langchain.com/python/langchain/agents/middleware/human_in_the_loop/HumanInTheLoopMiddleware)
- LlamaIndex: [HITL docs](https://developers.llamaindex.ai/python/framework/understanding/agent/human_in_the_loop/)
- PydanticAI: [Deferred Tools docs](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/), [Issue #3274 HITL multi-agent](https://github.com/pydantic/pydantic-ai/issues/3274)
- CrewAI: [Human Input docs](https://docs.crewai.com/how-to/human-input-on-execution), [allowed_agents PR #2068](https://github.com/crewAIInc/crewAI/pull/2068)
- Agno: [User Confirmation docs](https://docs.agno.com/execution-control/hitl/user-confirmation), [MCP approval changelog](https://www.agno.com/changelog/enforce-human-approval-for-mcp-tool-calls)
- Semantic Kernel: [Filters docs](https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/filters), [`AutoFunctionInvocationFiltering.cs` sample](https://github.com/microsoft/semantic-kernel/blob/main/dotnet/samples/Concepts/Filtering/AutoFunctionInvocationFiltering.cs)
