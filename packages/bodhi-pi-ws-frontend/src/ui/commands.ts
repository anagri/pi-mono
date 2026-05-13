import type { AvailableCommand, ClientSideConnection } from "@agentclientprotocol/sdk";

const EXT_DELETE_SESSION = "_bodhi-pi/session/delete";
const EXT_SESSION_COMPACT = "_bodhi-pi/session/compact";
const EXT_SESSION_FORK = "_bodhi-pi/session/fork";
const EXT_SESSION_CLONE = "_bodhi-pi/session/clone";
const EXT_SESSION_ENTRIES = "_bodhi-pi/session/entries";
const EXT_SESSION_TREE = "_bodhi-pi/session/tree";
const EXT_SESSION_NAVIGATE = "_bodhi-pi/session/navigate";
const EXT_SESSION_SET_NAME = "_bodhi-pi/session/setName";
const EXT_SESSION_STATS = "_bodhi-pi/session/stats";
const EXT_SESSION_EXPORT = "_bodhi-pi/session/export";
const EXT_SESSION_CONFIG = "_bodhi-pi/session/config";
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

export interface UiCommandContext {
	conn: ClientSideConnection;
	cwd: string;
	sessionId: string;
	currentModelId: string;
	defaultModelId: string;
	availableCommands: AvailableCommand[];
	addSystemMessage: (text: string) => void;
	setCurrentModelId: (id: string) => void;
	setSessionId: (id: string) => void;
	setStatus: (s: "idle" | "streaming" | "closed") => void;
	clear: () => void;
}

export function isCommand(line: string): boolean {
	return line.startsWith("/");
}

type LoadSessionCapable = {
	loadSession?: (params: { sessionId: string; cwd: string; mcpServers: never[] }) => Promise<{
		configOptions?: { currentValue?: string }[];
	}>;
	listSessions?: (params: { cwd?: string; cursor?: string }) => Promise<{
		sessions: { sessionId: string; cwd: string; updatedAt?: number }[];
		nextCursor?: string;
	}>;
	closeSession?: (params: { sessionId: string }) => Promise<unknown>;
};

/**
 * Dispatch a slash command. Returns true when handled locally; false when the
 * caller should forward the line to the agent as a prompt (i.e. the slash
 * command is a project-defined `/<name>` from `.bodhi-pi/commands/`).
 *
 * Ported from `bodhi-pi-web/src/ui/commands.ts`. ws-frontend differences:
 *   - `closeSession`/`listSessions`/`loadSession` accessed via type-assertion
 *     because the bundled `ClientSideConnection` declares them as optional.
 *   - No `/quit` (no terminal); no `/mount` (no FSA picker).
 */
export async function handleCommand(line: string, ctx: UiCommandContext): Promise<boolean> {
	const parts = line.trim().split(/\s+/);
	const cmd = parts[0];
	const c = ctx.conn as unknown as LoadSessionCapable;

	switch (cmd) {
		case "/help": {
			const lines = [
				"local commands:",
				"  /help              show this help",
				"  /model [id]        show current model (only one model in PoC; switching is M-future)",
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
				'  /login <provider> [api_key="..."] [base_url="..."]   store provider auth',
				"  /logout <provider>            remove stored auth",
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
			try {
				const result = await ctx.conn.setSessionConfigOption({
					sessionId: ctx.sessionId,
					configId: "model",
					value: modelId,
				});
				const opt = result.configOptions?.[0];
				const newId =
					opt && typeof (opt as { currentValue?: unknown }).currentValue === "string"
						? (opt as { currentValue: string }).currentValue
						: modelId;
				ctx.setCurrentModelId(newId);
				ctx.addSystemMessage(`model switched to: ${newId}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		case "/sessions": {
			if (typeof c.listSessions !== "function") {
				ctx.addSystemMessage("server does not support session/list");
				return true;
			}
			try {
				const lines = ["sessions:"];
				let cursor: string | undefined;
				let total = 0;
				do {
					const result = await c.listSessions(cursor ? { cursor } : {});
					const sessions = result.sessions ?? [];
					for (const s of sessions) {
						const marker = s.sessionId === ctx.sessionId ? "*" : " ";
						const updated = typeof s.updatedAt === "number" ? formatAge(s.updatedAt) : "";
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
				if (ctx.sessionId && typeof c.closeSession === "function") {
					await c.closeSession({ sessionId: ctx.sessionId });
				}
				const result = await ctx.conn.newSession({ cwd: ctx.cwd, mcpServers: [] });
				ctx.clear();
				ctx.setSessionId(result.sessionId);
				if (ctx.defaultModelId) ctx.setCurrentModelId(ctx.defaultModelId);
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
			if (typeof c.loadSession !== "function") {
				ctx.addSystemMessage("server does not support session/load");
				return true;
			}
			try {
				if (ctx.sessionId && ctx.sessionId !== targetId && typeof c.closeSession === "function") {
					await c.closeSession({ sessionId: ctx.sessionId });
				}
				ctx.clear();
				ctx.setSessionId(targetId);
				const result = await c.loadSession({ sessionId: targetId, cwd: ctx.cwd, mcpServers: [] });
				const opt = result.configOptions?.[0];
				const restoredModel =
					opt && typeof (opt as { currentValue?: unknown }).currentValue === "string"
						? (opt as { currentValue: string }).currentValue
						: ctx.defaultModelId;
				if (restoredModel) ctx.setCurrentModelId(restoredModel);
				ctx.setStatus("idle");
				ctx.addSystemMessage(`resumed session: ${targetId.slice(0, 8)}…`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
				ctx.setStatus("idle");
			}
			return true;
		}

		case "/close": {
			if (!ctx.sessionId) {
				ctx.addSystemMessage("(no active session)");
				return true;
			}
			if (typeof c.closeSession !== "function") {
				ctx.addSystemMessage("server does not support session/close");
				return true;
			}
			try {
				await c.closeSession({ sessionId: ctx.sessionId });
				ctx.setStatus("closed");
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
				await ctx.conn.extMethod(EXT_DELETE_SESSION, { sessionId: targetId });
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
			const customInstructions = parts.slice(1).join(" ").trim() || undefined;
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_COMPACT, {
					sessionId: ctx.sessionId,
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
					sessionId: ctx.sessionId,
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
				const result = (await ctx.conn.extMethod(EXT_SESSION_TREE, { sessionId: ctx.sessionId })) as {
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
					sessionId: ctx.sessionId,
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
					sessionId: ctx.sessionId,
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
					sessionId: ctx.sessionId,
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
					sessionId: ctx.sessionId,
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
					sessionId: ctx.sessionId,
				})) as { messageCount: number; toolCallCount: number; leafId: string; name?: string };
				const lines = [
					`session: ${ctx.sessionId}`,
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
					sessionId: ctx.sessionId,
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
					sessionId: ctx.sessionId,
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
						sessionId: ctx.sessionId,
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
						sessionId: ctx.sessionId,
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
						sessionId: ctx.sessionId,
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
						sessionId: ctx.sessionId,
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
			const parsed = parseLoginArgsLocal(parts.slice(1).join(" "));
			if ("error" in parsed) {
				ctx.addSystemMessage(parsed.error);
				return true;
			}
			try {
				await ctx.conn.extMethod(EXT_KV_SET, {
					sessionId: ctx.sessionId,
					key: `${AUTH_PREFIX}${parsed.provider}`,
					value: parsed.value,
				});
				ctx.addSystemMessage(`stored auth for ${parsed.provider}`);
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
				const result = (await ctx.conn.extMethod(EXT_KV_LIST, { prefix: AUTH_PREFIX })) as {
					entries: Array<{ key: string; value: unknown }>;
				};
				if (result.entries.length === 0) {
					ctx.addSystemMessage("(no stored auth)");
				} else {
					const lines = result.entries.map((e) => {
						const provider = e.key.startsWith(AUTH_PREFIX) ? e.key.slice(AUTH_PREFIX.length) : e.key;
						return `  ${provider}: ${formatProviderAuthLocal(e.value)}`;
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

const KEYLESS_DEFAULTS: Record<string, string> = { ollama: "http://localhost:11434/v1" };

// Local copy: ws-frontend cannot import @bodhiapp/bodhi-pi (no-agent rule).
// Keep behavior aligned with parseLoginArgs/formatProviderAuth in bodhi-pi.
function parseLoginArgsLocal(input: string): { provider: string; value: Record<string, unknown> } | { error: string } {
	const positionals: string[] = [];
	const kwargs: Record<string, string> = {};
	let i = 0;
	const s = input;
	const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
	while (i < s.length) {
		while (i < s.length && isSpace(s[i])) i++;
		if (i >= s.length) break;
		const tokenStart = i;
		while (i < s.length && !isSpace(s[i]) && s[i] !== "=" && s[i] !== '"' && s[i] !== "'") i++;
		const beforeEq = s.slice(tokenStart, i);
		let key: string | null = null;
		if (i < s.length && s[i] === "=") {
			key = beforeEq;
			i++;
		}
		let value: string;
		if (i < s.length && (s[i] === '"' || s[i] === "'")) {
			const quote = s[i];
			i++;
			let v = "";
			while (i < s.length && s[i] !== quote) {
				if (s[i] === "\\" && i + 1 < s.length && s[i + 1] === quote) {
					v += quote;
					i += 2;
				} else {
					v += s[i];
					i++;
				}
			}
			if (i >= s.length) return { error: "unterminated quoted value" };
			i++;
			value = v;
		} else {
			const valueStart = i;
			while (i < s.length && !isSpace(s[i])) i++;
			value = s.slice(valueStart, i);
		}
		if (key === null) positionals.push(beforeEq);
		else if (!key) return { error: "empty key in key=value pair" };
		else kwargs[key] = value;
	}
	const provider = positionals[0];
	if (!provider) return { error: 'usage: /login <provider> [api_key="..."] [base_url="..."]' };
	const value: Record<string, unknown> = {};
	if (kwargs.api_key !== undefined) value.api_key = { value: kwargs.api_key, secret: true };
	if (kwargs.base_url !== undefined) value.base_url = kwargs.base_url;
	if (!value.api_key && !value.base_url) {
		const def = KEYLESS_DEFAULTS[provider];
		if (def) value.base_url = def;
		else return { error: `usage: /login ${provider} api_key="..." [base_url="..."]` };
	}
	return { provider, value };
}

function formatProviderAuthLocal(value: unknown): string {
	const parts: string[] = [];
	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const ak = obj.api_key as { value?: unknown } | undefined;
		if (ak && typeof ak.value === "string") parts.push(`api_key=${ak.value}`);
		if (typeof obj.base_url === "string") parts.push(`base_url=${obj.base_url}`);
	}
	return parts.join(" ") || "(no fields)";
}
