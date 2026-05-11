import type { AvailableCommand } from "../hooks/useChat.ts";
import type { AcpHttpClient } from "../lib/acp-http-client.ts";

export interface UiCommandContext {
	client: AcpHttpClient;
	sessionId: string | undefined;
	currentModelId: string;
	defaultModelId: string;
	availableCommands: AvailableCommand[];
	addSystemMessage: (text: string) => void;
	setCurrentModelId: (id: string) => void;
	setSessionId: (id: string | undefined) => void;
	clearMessages: () => void;
	loadSession: (sessionId: string) => Promise<{ configOptions?: { id: string; currentValue: string }[] } | undefined>;
}

export function isCommand(line: string): boolean {
	return line.startsWith("/");
}

const EXT_SESSION_SETTINGS_GET = "_bodhi-pi/session/settings/get";
const EXT_SESSION_SETTINGS_SET = "_bodhi-pi/session/settings/set";
const EXT_SESSION_SETTINGS_UNSET = "_bodhi-pi/session/settings/unset";
const EXT_SESSION_SETTINGS_LIST = "_bodhi-pi/session/settings/list";
const EXT_KV_SET = "_bodhi-pi/kv/set";
const EXT_KV_LIST = "_bodhi-pi/kv/list";
const EXT_KV_REMOVE = "_bodhi-pi/kv/remove";
const AUTH_PREFIX = "auth/";

function extractScopeFlag(tokens: string[]): { scope?: "global" | "project" | "session"; rest: string[] } {
	const rest: string[] = [];
	let scope: "global" | "project" | "session" | undefined;
	for (const t of tokens) {
		if (t === "--global") scope = "global";
		else if (t === "--project") scope = "project";
		else if (t === "--session") scope = "session";
		else if (t === "--effective") scope = undefined;
		else rest.push(t);
	}
	return { ...(scope !== undefined ? { scope } : {}), rest };
}

/**
 * Slash-command dispatcher. Returns `true` when handled locally; `false` when
 * the caller should forward the line to the agent as a prompt (project commands
 * defined in `.bodhi-pi/commands/<name>.md` arrive here as `/<name>`).
 *
 * Ported from `bodhi-pi-ws-frontend/src/ui/commands.ts:43-210`. Differences:
 *   - Uses `AcpHttpClient` (HTTP+SSE) instead of `ClientSideConnection` (WS).
 *   - No serverUrl in context (same-origin).
 */
export async function handleCommand(line: string, ctx: UiCommandContext): Promise<boolean> {
	const parts = line.trim().split(/\s+/);
	const cmd = parts[0];

	switch (cmd) {
		case "/help": {
			const lines = [
				"local commands:",
				"  /help              show this help",
				"  /model [id]        show current model or switch to <id>",
				"  /sessions          list sessions for this user",
				"  /new               start a new session",
				"  /resume <id>       load a previous session (replays history)",
				"  /close             close the current session (data persists)",
				"  /delete <id>       permanently delete a session",
				"  /compact [hint]    summarize earlier turns to free context",
				"  /entries           list message entry ids on the current branch",
				"  /tree              show the full session DAG (all entries)",
				"  /goto <entryId>    move the leaf to <entryId>; subsequent prompts branch from there",
				"  /fork <entryId>    fork before <entryId> (returns new session id)",
				"  /clone             clone the current session at the leaf",
				"  /name <text>       set the session display name",
				"  /session           show session stats (counts + leaf id)",
				"  /export            copy the session JSONL to clipboard",
				"  /config            show resolved per-session config (compaction, append, AGENTS.md paths)",
				"  /settings list     [--global|--project|--session|--effective]",
				"  /settings get <key>     [--global|--project|--session]",
				"  /settings set <key> <value>  [--global|--project|--session]   (default --session)",
				"  /settings unset <key>   [--global|--project|--session]",
				"  /login <provider> <api-key>   store an API key (secret)",
				"  /logout <provider>            remove a stored API key",
				"  /logins                       list providers with stored auth (masked)",
			];
			if (ctx.availableCommands.length > 0) {
				lines.push("", "agent slash commands:");
				for (const ac of ctx.availableCommands) {
					const hint = ac.input ? ` <${ac.input.hint ?? "input"}>` : "";
					lines.push(`  /${ac.name}${hint}  ${ac.description}`);
				}
			}
			ctx.addSystemMessage(lines.join("\n"));
			return true;
		}

		case "/model": {
			const modelId = parts[1];
			if (!modelId) {
				ctx.addSystemMessage(`current model: ${ctx.currentModelId || "(unknown)"}`);
				return true;
			}
			if (!ctx.sessionId) {
				ctx.addSystemMessage("(no active session)");
				return true;
			}
			try {
				const result = await ctx.client.setSessionConfigOption({
					sessionId: ctx.sessionId,
					configId: "model",
					value: modelId,
				});
				// Per-turn agent rebuild — notifications dispatched during
				// non-SSE methods don't reach the frontend; read the
				// spec-mandated response field.
				const opt = result.configOptions.find((o) => o.id === "model");
				const newId = opt?.currentValue ?? modelId;
				ctx.setCurrentModelId(newId);
				ctx.addSystemMessage(`model switched to: ${newId}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/sessions": {
			try {
				const lines = ["sessions:"];
				let cursor: string | undefined;
				let total = 0;
				do {
					const result = await ctx.client.listSessions(cursor ? { cursor } : {});
					const sessions = result.sessions ?? [];
					for (const s of sessions) {
						const marker = s.sessionId === ctx.sessionId ? "*" : " ";
						const updated = formatAge(s.updatedAt);
						lines.push(`${marker} ${s.sessionId}  ${updated}`);
					}
					total += sessions.length;
					cursor = result.nextCursor;
				} while (cursor);
				ctx.addSystemMessage(total === 0 ? "(no sessions)" : lines.join("\n"));
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/new": {
			try {
				if (ctx.sessionId) {
					await ctx.client.closeSession(ctx.sessionId).catch(() => {});
				}
				const result = await ctx.client.newSession({});
				ctx.clearMessages();
				ctx.setSessionId(result.sessionId);
				const m = result.configOptions?.find((c) => c.id === "model");
				if (m) ctx.setCurrentModelId(m.currentValue);
				else if (ctx.defaultModelId) ctx.setCurrentModelId(ctx.defaultModelId);
				if (result.availableCommands && result.availableCommands.length > 0) {
					ctx.client.dispatchNotificationForReplay("session/update", {
						sessionId: result.sessionId,
						update: {
							sessionUpdate: "available_commands_update",
							availableCommands: result.availableCommands,
						},
					});
				}
				ctx.addSystemMessage(`new session: ${result.sessionId.slice(0, 8)}…`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/resume": {
			const targetId = parts[1];
			if (!targetId) {
				ctx.addSystemMessage("usage: /resume <session-id>");
				return true;
			}
			try {
				if (ctx.sessionId && ctx.sessionId !== targetId) {
					await ctx.client.closeSession(ctx.sessionId).catch(() => {});
				}
				ctx.clearMessages();
				ctx.setSessionId(targetId);
				const loaded = await ctx.loadSession(targetId);
				const m = loaded?.configOptions?.find((c) => c.id === "model");
				if (m) ctx.setCurrentModelId(m.currentValue);
				ctx.addSystemMessage(`resumed session: ${targetId.slice(0, 8)}…`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/close": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("(no active session)");
				return true;
			}
			try {
				await ctx.client.closeSession(ctx.sessionId);
				// Keep sessionId set so the auto-resume effect doesn't immediately
				// recreate. The persisted session remains; /new makes a fresh one;
				// /resume loads any (including this one) back into memory.
				ctx.addSystemMessage(`closed session: ${ctx.sessionId.slice(0, 8)}…  (use /new or /resume <id>)`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/delete": {
			const targetId = parts[1];
			if (!targetId) {
				ctx.addSystemMessage("usage: /delete <session-id>");
				return true;
			}
			try {
				await ctx.client.deleteSession(targetId);
				ctx.addSystemMessage(`deleted session: ${targetId.slice(0, 8)}…`);
				if (targetId === ctx.sessionId) {
					await handleCommand("/new", ctx);
				}
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/compact": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			const customInstructions = parts.slice(1).join(" ").trim() || undefined;
			try {
				const result = await ctx.client.compactSession({
					sessionId: ctx.sessionId,
					...(customInstructions ? { customInstructions } : {}),
				});
				ctx.addSystemMessage(`compacted (was ~${result.tokensBefore} tokens)\n\n${result.summary}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/entries": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			try {
				const result = await ctx.client.listSessionEntries({ sessionId: ctx.sessionId });
				if (result.entries.length === 0) {
					ctx.addSystemMessage("(no message entries)");
				} else {
					ctx.addSystemMessage(
						["entries:", ...result.entries.map((e) => `  ${e.id}  ${e.role.padEnd(9)} ${e.preview}`)].join("\n"),
					);
				}
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/tree": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			try {
				const result = await ctx.client.getSessionTree({ sessionId: ctx.sessionId });
				if (result.nodes.length === 0) {
					ctx.addSystemMessage("(empty session)");
				} else {
					const lines = ["tree:"];
					for (const n of result.nodes) {
						const marker = n.isLeaf ? "*" : " ";
						const role = n.role ?? n.type;
						const preview = n.preview ?? "";
						lines.push(`${marker} ${n.id}  ${role.padEnd(9)} ${preview}`);
					}
					ctx.addSystemMessage(lines.join("\n"));
				}
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/goto": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			const targetEntryId = parts[1];
			if (!targetEntryId) {
				ctx.addSystemMessage("usage: /goto <entry-id>");
				return true;
			}
			try {
				const result = await ctx.client.navigateSession({ sessionId: ctx.sessionId, targetEntryId });
				ctx.addSystemMessage(`leaf moved to: ${result.leafId}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/fork": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			const entryId = parts[1];
			if (!entryId) {
				ctx.addSystemMessage("usage: /fork <entry-id>");
				return true;
			}
			try {
				const result = await ctx.client.forkSession({ sessionId: ctx.sessionId, entryId, position: "before" });
				ctx.addSystemMessage(
					`forked: ${result.newSessionId}${result.selectedText ? `\n  user message: ${result.selectedText}` : ""}`,
				);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/clone": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			try {
				const result = await ctx.client.cloneSession({ sessionId: ctx.sessionId });
				ctx.addSystemMessage(`cloned: ${result.newSessionId}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/name": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			const name = parts.slice(1).join(" ").trim();
			if (!name) {
				ctx.addSystemMessage("usage: /name <display name>");
				return true;
			}
			try {
				const result = await ctx.client.setSessionName({ sessionId: ctx.sessionId, name });
				ctx.addSystemMessage(`session name set to: ${result.name}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/session": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			try {
				const result = await ctx.client.getSessionStats({ sessionId: ctx.sessionId });
				const lines = [
					`session: ${ctx.sessionId}`,
					...(result.name ? [`  name: ${result.name}`] : []),
					`  messages: ${result.messageCount}`,
					`  tool calls: ${result.toolCallCount}`,
					`  leaf: ${result.leafId ?? "(none)"}`,
				];
				ctx.addSystemMessage(lines.join("\n"));
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/export": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			try {
				const result = await ctx.client.exportSession({ sessionId: ctx.sessionId });
				try {
					await navigator.clipboard.writeText(result.content);
					ctx.addSystemMessage(
						`exported (${result.format}, ${result.content.length} bytes) — copied to clipboard`,
					);
				} catch {
					ctx.addSystemMessage(`exported (${result.format}, ${result.content.length} bytes)\n${result.content}`);
				}
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/config": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("error: no active session");
				return true;
			}
			try {
				const result = await ctx.client.getSessionConfig({ sessionId: ctx.sessionId });
				const lines = [
					`cwd: ${result.cwd}`,
					`default model: ${result.defaultModelId}`,
					`current model: ${result.currentModelId}`,
					`compaction.enabled: ${result.compaction.enabled}`,
					`compaction.reserveTokens: ${result.compaction.reserveTokens}`,
					`compaction.keepRecentTokens: ${result.compaction.keepRecentTokens}`,
					`appendSystemPrompt: ${result.appendSystemPrompt ?? "(none)"}`,
					`project settings present: ${result.projectSettingsPresent}`,
					`context files: ${result.contextFilePaths.length === 0 ? "(none)" : ""}`,
					...result.contextFilePaths.map((p) => `  - ${p}`),
				];
				ctx.addSystemMessage(lines.join("\n"));
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/settings": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("(no active session)");
				return true;
			}
			const sub = parts[1];
			if (!sub) {
				ctx.addSystemMessage("usage: /settings list|get|set|unset ...");
				return true;
			}
			const tail = parts.slice(2);
			try {
				if (sub === "list") {
					const { scope } = extractScopeFlag(tail);
					const result = await ctx.client.extMethod<{ scope: string; settings: Record<string, unknown> }>(
						EXT_SESSION_SETTINGS_LIST,
						{ sessionId: ctx.sessionId, ...(scope ? { scope } : {}) },
					);
					const entries = Object.entries(result.settings ?? {});
					const lines = [`scope: ${result.scope}`];
					if (entries.length === 0) lines.push("  (empty)");
					for (const [k, v] of entries) lines.push(`  ${k} = ${JSON.stringify(v)}`);
					ctx.addSystemMessage(lines.join("\n"));
				} else if (sub === "get") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					if (!key) {
						ctx.addSystemMessage("usage: /settings get <key> [--scope]");
						return true;
					}
					const result = await ctx.client.extMethod<{ key: string; effective: unknown; source: string }>(
						EXT_SESSION_SETTINGS_GET,
						{ sessionId: ctx.sessionId, key, ...(scope ? { scope } : {}) },
					);
					ctx.addSystemMessage(`${result.key} = ${JSON.stringify(result.effective)}  (source: ${result.source})`);
				} else if (sub === "set") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					const value = rest.slice(1).join(" ");
					if (!key || rest.length < 2) {
						ctx.addSystemMessage("usage: /settings set <key> <value> [--scope]");
						return true;
					}
					const result = await ctx.client.extMethod<{ scope: string; effective: unknown }>(
						EXT_SESSION_SETTINGS_SET,
						{ sessionId: ctx.sessionId, key, value, ...(scope ? { scope } : {}) },
					);
					ctx.addSystemMessage(
						`set ${key} (scope: ${result.scope}); effective = ${JSON.stringify(result.effective)}`,
					);
				} else if (sub === "unset") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					if (!key) {
						ctx.addSystemMessage("usage: /settings unset <key> [--scope]");
						return true;
					}
					const result = await ctx.client.extMethod<{ scope: string; effective: unknown }>(
						EXT_SESSION_SETTINGS_UNSET,
						{ sessionId: ctx.sessionId, key, ...(scope ? { scope } : {}) },
					);
					ctx.addSystemMessage(
						`unset ${key} (scope: ${result.scope}); effective = ${JSON.stringify(result.effective)}`,
					);
				} else {
					ctx.addSystemMessage(`unknown /settings subcommand: ${sub}`);
				}
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/login": {
			const provider = parts[1];
			const apiKey = parts.slice(2).join(" ").trim();
			if (!provider || !apiKey) {
				ctx.addSystemMessage("usage: /login <provider> <api-key>");
				return true;
			}
			try {
				await ctx.client.extMethod(EXT_KV_SET, {
					sessionId: ctx.sessionId,
					key: `${AUTH_PREFIX}${provider}`,
					value: apiKey,
					secret: true,
				});
				// Picker state refresh arrives via `config_option_update` sessionUpdate.
				ctx.addSystemMessage(`stored auth for ${provider}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/logout": {
			const provider = parts[1];
			if (!provider) {
				ctx.addSystemMessage("usage: /logout <provider>");
				return true;
			}
			try {
				await ctx.client.extMethod(EXT_KV_REMOVE, {
					sessionId: ctx.sessionId,
					key: `${AUTH_PREFIX}${provider}`,
				});
				// Picker state refresh arrives via `config_option_update` sessionUpdate.
				ctx.addSystemMessage(`removed auth for ${provider}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/logins": {
			try {
				const result = await ctx.client.extMethod<{
					entries: Array<{ key: string; value: string; secret: boolean }>;
				}>(EXT_KV_LIST, { prefix: AUTH_PREFIX });
				if (result.entries.length === 0) {
					ctx.addSystemMessage("(no stored auth)");
				} else {
					const lines = result.entries.map((e) => {
						const provider = e.key.startsWith(AUTH_PREFIX) ? e.key.slice(AUTH_PREFIX.length) : e.key;
						return `  ${provider}: ${e.value}`;
					});
					ctx.addSystemMessage(["stored auth:", ...lines].join("\n"));
				}
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		default:
			return false;
	}
}

function formatAge(raw: string | number | undefined): string {
	if (raw === undefined) return "";
	const ms = typeof raw === "string" ? Date.parse(raw) : raw;
	if (!Number.isFinite(ms)) return "";
	const diff = Date.now() - ms;
	const min = Math.floor(diff / 60000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}
