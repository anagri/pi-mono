# claude-agent-acp adapter — deep-read

Local: `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/claude-agent-acp/`. ACP SDK `0.22.0` + `@anthropic-ai/claude-agent-sdk 0.3.143`.

## Mode advertisement: ALL cc modes exposed, conditionally

`src/acp-agent.ts:2290-2333` — `buildAvailableModes(modelInfo)`:

```ts
function buildAvailableModes(modelInfo: ModelInfo | undefined): SessionModeState["availableModes"] {
  const modes: SessionModeState["availableModes"] = [];

  // model-gated: auto only when SDK reports support
  if (modelInfo?.supportsAutoMode === true) {
    modes.push({ id: "auto", name: "Auto", description: "Use a model classifier to approve/deny permission prompts" });
  }

  modes.push(
    { id: "default",     name: "Default",       description: "Standard behavior, prompts for dangerous operations" },
    { id: "acceptEdits", name: "Accept Edits",  description: "Auto-accept file edit operations" },
    { id: "plan",        name: "Plan Mode",     description: "Planning mode, no actual tool execution" },
    { id: "dontAsk",     name: "Don't Ask",     description: "Don't prompt for permissions, deny if not pre-approved" },
  );

  if (ALLOW_BYPASS) {
    modes.push({ id: "bypassPermissions", name: "Bypass Permissions", description: "Bypass all permission checks" });
  }

  return modes;
}
```

- `auto` — gated by model capability (Haiku doesn't support it; Opus does)
- `default`, `acceptEdits`, `plan`, `dontAsk` — always advertised
- `bypassPermissions` — `ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX` (line 339) — hidden if running as root and not in sandbox

**Lesson for bodhi-pi**: capability-gated advertisement is a known-good pattern. Bodhi-pi already does this for `allowsAllowAllMode`.

## `setSessionMode` handler (uses deprecated path BUT also updates configOption)

`src/acp-agent.ts:1332-1340`:

```ts
async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
  if (!this.sessions[params.sessionId]) throw new Error("Session not found");
  await this.applySessionMode(params.sessionId, params.modeId);
  await this.updateConfigOption(params.sessionId, "mode", params.modeId);  // ★ supports BOTH paths
  return {};
}
```

`applySessionMode` (line 1408-1442) validates the modeId, checks against `session.modes.availableModes`, then delegates to `session.query.setPermissionMode(modeId)` (cc's native API).

**Bilingual support** — claude-agent-acp ships BOTH the deprecated `setSessionMode` AND the new `setSessionConfigOption` simultaneously for client back-compat. Bodhi-pi can ship NEW path only (no production users yet); migration is a non-issue.

## `requestPermission` — 3 options for normal tools, 5 for plan exit

Normal flow (`src/acp-agent.ts:1588-1640`):

```ts
const response = await this.client.requestPermission({
  options: [
    { kind: "allow_always", name: alwaysAllowLabel,           optionId: "allow_always" },
    { kind: "allow_once",   name: "Allow",                    optionId: "allow" },
    { kind: "reject_once",  name: "Reject",                   optionId: "reject" },
  ],
  sessionId,
  toolCall: { toolCallId: toolUseID, rawInput: toolInput, ... },
});
```

**3 options, not 4** — `reject_always` is omitted in normal flow. Zed renders it greyed-out anyway. claude-agent-acp's choice: don't offer it.

Plan-exit flow (`src/acp-agent.ts:1490-1525`):

```ts
const optionsAll: PermissionOption[] = [
  { kind: "allow_always", name: 'Yes, and use "auto" mode',         optionId: "auto" },
  { kind: "allow_always", name: "Yes, and auto-accept edits",        optionId: "acceptEdits" },
  { kind: "allow_once",   name: "Yes, and manually approve edits",   optionId: "default" },
  { kind: "reject_once",  name: "No, keep planning",                  optionId: "plan" },
];
if (ALLOW_BYPASS) optionsAll.unshift({ kind: "allow_always", name: "Yes, and bypass permissions", optionId: "bypassPermissions" });

// filter against currently-advertised modes
const options = optionsAll.filter(o => session.modes.availableModes.some(m => m.id === o.optionId));
```

**`optionId` IS the target mode** — when user selects "Yes, and auto-accept edits", the adapter switches mode to `acceptEdits` AND auto-allows the exit. The 4 PermissionOption-kinds are bent to a custom semantic.

Bodhi-pi's `submit_plan` should mirror this pattern: options are `approve+switch-to-edit`, `approve+stay-in-plan-with-feedback`, `revise`.

## Outcome → cc's expected `PermissionResponse` shape

`src/acp-agent.ts:1617-1632`:

```ts
if (response.outcome?.outcome === "selected" && (optionId === "allow" || optionId === "allow_always")) {
  if (optionId === "allow_always") {
    return {
      behavior: "allow",
      updatedInput: toolInput,
      updatedPermissions: suggestions ?? [
        { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
      ],
    };
  }
  return { behavior: "allow", updatedInput: toolInput };
} else {
  return { behavior: "deny", message: "User refused permission to run tool" };
}
```

`destination: "session"` — allow_always defaults to session scope. cc's SDK persists per the destination. Bodhi-pi's milestone 090 will offer session/project/global scope picker — broader than cc's session-default.

## `CurrentModeUpdate` emission — three trigger points

1. **During permission resolution** (line 1554-1560) — when plan-exit selects a mode
2. **When cc internally enters plan mode** (line 1970-1978) — post-tool hook on `onEnterPlanMode`
3. **When model fallback happens** (line 2104-2124) — if model that doesn't support current mode is selected, adapter clamps

Bodhi-pi has analogous triggers: user-initiated `setSessionMode`, `submit_plan` approval auto-transition, future model-capability clamp.

## Filesystem — pure pass-through to ACP client

`src/acp-agent.ts:1478-1486`:

```ts
async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  const response = await this.client.readTextFile(params);
  return response;
}

async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  const response = await this.client.writeTextFile(params);
  return response;
}
```

**The adapter sits on the agent side but routes fs through the ACP client**. cc's internal tools (`Edit`, `Write`, etc.) get their fs operations re-routed to the ACP client (Zed). This is standard ACP.

**Different from bodhi-pi**: bodhi-pi runs tools that talk directly to the injected `Filesystem` adapter. No round-trip. The host IS the trust boundary (because the host injected the adapter), not a separate client.

## Permission persistence

Delegated to cc's SDK via the `updatedPermissions` return value with `destination: "session"`. cc's SDK writes to `.claude/settings.json` (or local/global counterpart). The adapter never writes settings files itself.

Bodhi-pi's approach: write directly via `SettingsService.set("permission.alwaysAllow.<pattern>", true, scope)`. Simpler because bodhi-pi owns settings.

## Implication for bodhi-pi

| claude-agent-acp pattern | Bodhi-pi adoption |
|---|---|
| All cc modes exposed (with capability-gated subset) | Adopt: 4 hardcoded modes; capability-gated `allow-all` |
| 3 options for normal permission (omit `reject_always`) | Adopt: bodhi-pi offers 4 (since spec/Zed handle it cleanly), but document the rationale and add a `permissionOptionsKind` setting if a user wants 3 |
| Plan-exit options bundle approve+mode-switch via `optionId` | **Adopt for `submit_plan` tool** — 3 options: `approve` (switch to edit), `feedback` (stay in plan, replay with notes), `revise` (deny, replay request) |
| `optionId` is semantic, not just an arbitrary handle | Adopt: bodhi-pi's `submit_plan` uses `optionId: "edit"` to mean "approve and switch to edit mode" |
| Filesystem proxied through ACP `fs/*` | **Reject** — bodhi-pi's architecture explicitly chose the inverse |
| Persistence delegated to underlying agent SDK | **N/A** — bodhi-pi IS the agent; persistence is direct via SettingsService |
| Mode `dontAsk` (turns asks into denies) | Skip — bodhi-pi can express this via per-tool deny rules; not worth a separate mode |
