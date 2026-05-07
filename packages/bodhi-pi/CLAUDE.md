# bodhi-pi

ACP-side agent that wraps `pi-agent-core` and exposes it over the Agent Client Protocol. Hosts inject a `Filesystem` and `SessionStore`; this package owns the ACP wire, session lifecycle, and the built-in tool set (read/write/edit/ls/find/grep).

## Comments policy

Default to writing no comments. Add one only when the **why** is non-obvious to a reader who has the code in front of them.

- **Don't restate types or names.** `getApiKey: (provider: string) => string | undefined` does not need a JSDoc that says "Resolves API key per provider name." If the field is mandatory and the constructor enforces it, don't write "Mandatory; no default fallback" on every field — the validation in `createBodhiPiAgent` already says so.
- **Don't narrate what the next line does.** `// Restore latest model from history; fall back to default` above a one-liner that obviously does that is noise.
- **Do explain hidden constraints, invariants, or cross-module coupling.** Examples worth keeping in this codebase: why mutating `session.piAgent.state.model` actually re-routes the next turn (pi-ai reads it per turn); why `cancelled` is reset at the start of every `prompt`; why `closeSession` keeps the persisted record; ACP spec references that pin a behavior to an external contract.
- **Do flag protocol or wire-level rules** that aren't visible in the local code — e.g. error-code conventions (`RequestError(-32602/-32601)` vs plain `Error`), ACP `_`-prefix extension methods, why image blocks are dropped from tool results.
- **Prefer terse over thorough.** One sentence beats five. If you need a paragraph, the code probably needs to be split or renamed instead.
- **Don't reference the current task.** No "added for M3.2", "fix for issue #123", "used by the new health-pass flow." That belongs in the commit message and rots in source.
- **Tests don't need comments** unless the assertion encodes a non-obvious invariant. `it("rejects unknown sessionId")` is its own documentation.

When in doubt, delete the comment and see if the code still reads. If it does, leave it deleted.
