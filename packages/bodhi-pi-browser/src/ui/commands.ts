import type { AvailableCommand, ClientSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";
import {
	AUTH_PREFIX,
	EXT_DELETE_SESSION,
	EXT_KV_LIST,
	EXT_KV_REMOVE,
	EXT_KV_SET,
	EXT_SESSION_CLONE,
	EXT_SESSION_COMPACT,
	EXT_SESSION_CONFIG,
	EXT_SESSION_ENTRIES,
	EXT_SESSION_EXPORT,
	EXT_SESSION_FORK,
	EXT_SESSION_NAVIGATE,
	EXT_SESSION_SET_NAME,
	EXT_SESSION_SETTINGS_GET,
	EXT_SESSION_SETTINGS_LIST,
	EXT_SESSION_SETTINGS_SET,
	EXT_SESSION_SETTINGS_UNSET,
	EXT_SESSION_STATS,
	EXT_SESSION_TREE,
} from "@bodhiapp/bodhi-pi";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ChatState } from "../store/chatStore";

/**
 * Slash-command dispatcher for bodhi-pi-web. Ported from
 * `bodhi-pi-cli/src/repl/commands.ts` — same `clientConn`/state surface,
 * different sink (system messages instead of stdout). M4 ships /help and
 * /model; M5 adds /sessions, /new, /resume, /close, /delete.
 */

function modelIdFromOption(opt: SessionConfigOption | undefined): string | undefined {
	if (!opt || opt.type !== "select") return undefined;
	return opt.currentValue;
}

export interface UiCommandState {
	sessionId: string;
	currentModelId: string;
	defaultModelId: string;
	models: Model<Api>[];
	availableCommands: AvailableCommand[];
}

export interface UiCommandContext {
	conn: ClientSideConnection;
	state: UiCommandState;
	addSystemMessage: ChatState["addSystemMessage"];
	setCurrentModelId: ChatState["setCurrentModelId"];
	setSessionId: ChatState["setSessionId"];
	setStatus: ChatState["setStatus"];
	clear: ChatState["clear"];
	cwd: string;
}

export function isCommand(line: string): boolean {
	return line.startsWith("/");
}

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
 * Returns true if the slash command was handled locally; false if it should be
 * forwarded to the agent as a normal prompt (which is the case for any
 * `/<name>` whose name appears in `availableCommands`).
 */
export async function handleCommand(line: string, ctx: UiCommandContext): Promise<boolean> {
	const parts = line.trim().split(/\s+/);
	const cmd = parts[0];

	switch (cmd) {
		case "/help": {
			const lines = [
				"local commands:",
				"  /help              show this help",
				"  /model [id]        list models or switch the active one",
				"  /sessions          list sessions for this cwd",
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
			if (ctx.state.availableCommands.length > 0) {
				lines.push("", "agent slash commands:");
				for (const ac of ctx.state.availableCommands) {
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
				const rows = ctx.state.models.map((m) => {
					const marker = m.id === ctx.state.currentModelId ? "*" : " ";
					return `${marker} ${m.id}  (${m.provider})`;
				});
				ctx.addSystemMessage(["models:", ...rows].join("\n"));
				return true;
			}
			try {
				const result = await ctx.conn.setSessionConfigOption({
					sessionId: ctx.state.sessionId,
					configId: "model",
					value: modelId,
				});
				// Picker state refresh arrives via `config_option_update` sessionUpdate.
				const newId = modelIdFromOption(result.configOptions.find((o) => o.id === "model")) ?? modelId;
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
					const result = await ctx.conn.listSessions({ cwd: ctx.cwd, ...(cursor ? { cursor } : {}) });
					for (const s of result.sessions) {
						const marker = s.sessionId === ctx.state.sessionId ? "*" : " ";
						const updated = s.updatedAt ? formatAge(Date.parse(s.updatedAt)) : "";
						// Full sessionId is included so /resume <id> can be copy-pasted.
						lines.push(`${marker} ${s.sessionId}  ${updated}`);
					}
					total += result.sessions.length;
					cursor = result.nextCursor ?? undefined;
				} while (cursor);
				ctx.addSystemMessage(total === 0 ? "(no sessions for this cwd)" : lines.join("\n"));
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/new": {
			try {
				if (ctx.state.sessionId) {
					await ctx.conn.closeSession({ sessionId: ctx.state.sessionId });
				}
				const result = await ctx.conn.newSession({ cwd: ctx.cwd, mcpServers: [] });
				ctx.clear();
				ctx.setSessionId(result.sessionId);
				ctx.setCurrentModelId(modelIdFromOption(result.configOptions?.[0]) ?? ctx.state.defaultModelId);
				ctx.setStatus("idle");
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
				if (ctx.state.sessionId && ctx.state.sessionId !== targetId) {
					await ctx.conn.closeSession({ sessionId: ctx.state.sessionId });
				}
				ctx.clear();
				ctx.setSessionId(targetId);
				const result = await ctx.conn.loadSession({ sessionId: targetId, cwd: ctx.cwd, mcpServers: [] });
				const restoredModel = modelIdFromOption(result.configOptions?.[0]) ?? ctx.state.defaultModelId;
				ctx.setCurrentModelId(restoredModel);
				ctx.setStatus("idle");
				ctx.addSystemMessage(`resumed session: ${targetId.slice(0, 8)}…`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
				ctx.setStatus("idle");
			}
			return true;
		}

		case "/close": {
			try {
				await ctx.conn.closeSession({ sessionId: ctx.state.sessionId });
				ctx.setStatus("closed");
				ctx.addSystemMessage(`closed session: ${ctx.state.sessionId.slice(0, 8)}…  (use /new or /resume <id>)`);
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
				await ctx.conn.extMethod(EXT_DELETE_SESSION, { sessionId: targetId });
				ctx.addSystemMessage(`deleted session: ${targetId.slice(0, 8)}…`);
				if (targetId === ctx.state.sessionId) {
					// Recurse into /new to leave the user on a fresh, usable session.
					await handleCommand("/new", ctx);
				}
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/compact": {
			const customInstructions = parts.slice(1).join(" ").trim() || undefined;
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_COMPACT, {
					sessionId: ctx.state.sessionId,
					...(customInstructions ? { customInstructions } : {}),
				})) as { summary?: string; tokensBefore?: number };
				const tokens = typeof result.tokensBefore === "number" ? ` (was ~${result.tokensBefore} tokens)` : "";
				ctx.addSystemMessage(`compacted${tokens}\n\n${result.summary ?? ""}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/entries": {
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_ENTRIES, {
					sessionId: ctx.state.sessionId,
				})) as { entries: { id: string; role: string; preview: string }[] };
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
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_TREE, { sessionId: ctx.state.sessionId })) as {
					leafId: string | null;
					nodes: { id: string; type: string; role?: string; preview?: string; isLeaf: boolean }[];
				};
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
			const targetEntryId = parts[1];
			if (!targetEntryId) {
				ctx.addSystemMessage("usage: /goto <entry-id>");
				return true;
			}
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_NAVIGATE, {
					sessionId: ctx.state.sessionId,
					targetEntryId,
				})) as { leafId: string };
				ctx.addSystemMessage(`leaf moved to: ${result.leafId}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/fork": {
			const entryId = parts[1];
			if (!entryId) {
				ctx.addSystemMessage("usage: /fork <entry-id>");
				return true;
			}
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_FORK, {
					sessionId: ctx.state.sessionId,
					entryId,
					position: "before",
				})) as { newSessionId: string; selectedText?: string };
				ctx.addSystemMessage(
					`forked: ${result.newSessionId}${result.selectedText ? `\n  user message: ${result.selectedText}` : ""}`,
				);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/clone": {
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_CLONE, {
					sessionId: ctx.state.sessionId,
				})) as { newSessionId: string };
				ctx.addSystemMessage(`cloned: ${result.newSessionId}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/name": {
			const name = parts.slice(1).join(" ").trim();
			if (!name) {
				ctx.addSystemMessage("usage: /name <display name>");
				return true;
			}
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_SET_NAME, {
					sessionId: ctx.state.sessionId,
					name,
				})) as { name: string };
				ctx.addSystemMessage(`session name set to: ${result.name}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/session": {
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_STATS, {
					sessionId: ctx.state.sessionId,
				})) as { messageCount: number; toolCallCount: number; leafId: string; name?: string };
				const lines = [
					`session: ${ctx.state.sessionId}`,
					...(result.name ? [`  name: ${result.name}`] : []),
					`  messages: ${result.messageCount}`,
					`  tool calls: ${result.toolCallCount}`,
					`  leaf: ${result.leafId}`,
				];
				ctx.addSystemMessage(lines.join("\n"));
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/export": {
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_EXPORT, {
					sessionId: ctx.state.sessionId,
				})) as { format: string; content: string };
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
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_CONFIG, {
					sessionId: ctx.state.sessionId,
				})) as {
					cwd: string;
					defaultModelId: string;
					currentModelId: string;
					compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
					appendSystemPrompt: string | null;
					contextFilePaths: string[];
				};
				const lines = [
					`cwd: ${result.cwd}`,
					`default model: ${result.defaultModelId}`,
					`current model: ${result.currentModelId}`,
					`compaction.enabled: ${result.compaction.enabled}`,
					`compaction.reserveTokens: ${result.compaction.reserveTokens}`,
					`compaction.keepRecentTokens: ${result.compaction.keepRecentTokens}`,
					`appendSystemPrompt: ${result.appendSystemPrompt ?? "(none)"}`,
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
			const sub = parts[1];
			if (!sub) {
				ctx.addSystemMessage("usage: /settings list|get|set|unset ...");
				return true;
			}
			const tail = parts.slice(2);
			try {
				if (sub === "list") {
					const { scope } = extractScopeFlag(tail);
					const result = (await ctx.conn.extMethod(EXT_SESSION_SETTINGS_LIST, {
						sessionId: ctx.state.sessionId,
						...(scope ? { scope } : {}),
					})) as { scope: string; settings: Record<string, unknown> };
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
					const result = (await ctx.conn.extMethod(EXT_SESSION_SETTINGS_GET, {
						sessionId: ctx.state.sessionId,
						key,
						...(scope ? { scope } : {}),
					})) as { key: string; effective: unknown; source: string };
					ctx.addSystemMessage(`${result.key} = ${JSON.stringify(result.effective)}  (source: ${result.source})`);
				} else if (sub === "set") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					const value = rest.slice(1).join(" ");
					if (!key || rest.length < 2) {
						ctx.addSystemMessage("usage: /settings set <key> <value> [--scope]");
						return true;
					}
					const result = (await ctx.conn.extMethod(EXT_SESSION_SETTINGS_SET, {
						sessionId: ctx.state.sessionId,
						key,
						value,
						...(scope ? { scope } : {}),
					})) as { scope: string; effective: unknown };
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
					const result = (await ctx.conn.extMethod(EXT_SESSION_SETTINGS_UNSET, {
						sessionId: ctx.state.sessionId,
						key,
						...(scope ? { scope } : {}),
					})) as { scope: string; effective: unknown };
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
				await ctx.conn.extMethod(EXT_KV_SET, {
					sessionId: ctx.state.sessionId,
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
				await ctx.conn.extMethod(EXT_KV_REMOVE, {
					sessionId: ctx.state.sessionId,
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
				const result = (await ctx.conn.extMethod(EXT_KV_LIST, { prefix: AUTH_PREFIX })) as {
					entries: Array<{ key: string; value: string; secret: boolean }>;
				};
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

function formatAge(ms: number): string {
	const diff = Date.now() - ms;
	const min = Math.floor(diff / 60000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}
