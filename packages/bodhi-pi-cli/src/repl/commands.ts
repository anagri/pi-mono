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
	type SessionStore,
} from "@bodhiapp/bodhi-pi";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Renderer } from "./render.js";

export interface ReplState {
	sessionId: string;
	currentModelId: string;
	defaultModelId: string;
	models: Model<Api>[];
	availableCommands: AvailableCommand[];
	closed: boolean;
}

export interface CommandContext {
	clientConn: ClientSideConnection;
	state: ReplState;
	sessionStore: SessionStore;
	renderer: Renderer;
	cwd: string;
}

export function isCommand(line: string): boolean {
	return line.startsWith("/");
}

/**
 * Update `state.models`/`currentModelId` from a fresh `configOptions[]` payload
 * returned by `setSessionConfigOption`, `/login`, `/logout`, or
 * `/settings set defaultModel*`. Non-destructive — silently no-ops if no `model`
 * option is present.
 */
function refreshStateFromConfigOptions(state: ReplState, options: readonly SessionConfigOption[] | undefined): void {
	if (!options) return;
	const modelOption = options.find((o) => o.id === "model");
	if (!modelOption || modelOption.type !== "select") return;
	const flat: Array<{ value: string; name?: string }> = [];
	for (const item of modelOption.options ?? []) {
		if ("value" in item) flat.push({ value: item.value, ...(item.name ? { name: item.name } : {}) });
	}
	state.models = flat.map(
		(o): Model<Api> =>
			({
				id: o.value,
				name: o.name ?? o.value,
				provider: "unknown",
				api: "unknown",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			}) as unknown as Model<Api>,
	);
	state.currentModelId = (modelOption.currentValue as string) ?? state.currentModelId;
}

/** Extract `--global|--project|--session` from a token list, returning the scope (or undefined) and remaining args. */
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

/** Returns true if the REPL should exit. */
export async function handleCommand(line: string, ctx: CommandContext): Promise<boolean> {
	const parts = line.trim().split(/\s+/);
	const cmd = parts[0];

	switch (cmd) {
		case "/help": {
			const lines = [
				"  /help              show this help",
				"  /new               start a new session",
				"  /sessions          list sessions for current cwd",
				"  /resume <id>       load a previous session (replays history)",
				"  /close             close the current session (data persists)",
				"  /delete <id>       permanently delete a session",
				"  /model <id>        switch model for current session",
				"  /compact [hint]    summarize earlier turns to free context",
				"  /entries           list message entry ids on the current branch",
				"  /tree              show the full session DAG (all entries)",
				"  /goto <entryId>    move the leaf to <entryId>; subsequent prompts branch from there",
				"  /fork <entryId>    fork before <entryId> (returns new session id)",
				"  /clone             clone the current session at the leaf",
				"  /name <text>       set the session display name",
				"  /session           show session stats (counts + leaf id)",
				"  /export            print the session as JSONL to stdout",
				"  /config            show resolved per-session config (compaction, append, AGENTS.md paths)",
				"  /settings list     [--global|--project|--session|--effective]",
				"  /settings get <key>     [--global|--project|--session]",
				"  /settings set <key> <value>  [--global|--project|--session]   (default --session)",
				"  /settings unset <key>   [--global|--project|--session]",
				"  /login <provider> <api-key>   store an API key (secret)",
				"  /logout <provider>            remove a stored API key",
				"  /logins                       list providers with stored auth (masked)",
				"  /quit              exit",
			];
			if (ctx.state.availableCommands.length > 0) {
				lines.push("", "  agent slash commands:");
				for (const cmd of ctx.state.availableCommands) {
					const hint = cmd.input ? ` <${cmd.input.hint ?? "input"}>` : "";
					const label = `  /${cmd.name}${hint}`;
					lines.push(`${label.padEnd(22)} ${cmd.description}`);
				}
			}
			lines.push("");
			process.stdout.write(lines.join("\n"));
			return false;
		}

		case "/new": {
			if (!ctx.state.closed && ctx.state.sessionId) {
				try {
					await ctx.clientConn.closeSession({ sessionId: ctx.state.sessionId });
				} catch {
					// Already-closed sessions throw; safe to ignore.
				}
			}
			const { sessionId } = await ctx.clientConn.newSession({ cwd: ctx.cwd, mcpServers: [] });
			ctx.state.sessionId = sessionId;
			ctx.state.currentModelId = ctx.state.defaultModelId || ctx.state.models[0]?.id || "";
			ctx.state.closed = false;
			process.stdout.write(`new session: ${sessionId}\n`);
			return false;
		}

		case "/sessions": {
			let cursor: string | undefined;
			let total = 0;
			do {
				const result = await ctx.sessionStore.list({ cwd: ctx.cwd, ...(cursor ? { cursor } : {}) });
				for (const s of result.sessions) {
					const ago = formatAge(s.updatedAt);
					const active = s.sessionId === ctx.state.sessionId ? " *" : "";
					process.stdout.write(`  ${s.sessionId.slice(0, 8)}…  ${s.messageCount} msgs  ${ago}${active}\n`);
				}
				total += result.sessions.length;
				cursor = result.nextCursor;
			} while (cursor);
			if (total === 0) process.stdout.write("  (no sessions for this directory)\n");
			return false;
		}

		case "/resume": {
			const targetId = parts[1];
			if (!targetId) {
				process.stdout.write("usage: /resume <session-id>\n");
				return false;
			}
			if (!ctx.state.closed && ctx.state.sessionId && ctx.state.sessionId !== targetId) {
				try {
					await ctx.clientConn.closeSession({ sessionId: ctx.state.sessionId });
				} catch {
					// already closed; ignore
				}
			}
			process.stdout.write("loading session history…\n");
			ctx.state.sessionId = targetId;
			try {
				const result = await ctx.clientConn.loadSession({ sessionId: targetId, cwd: ctx.cwd, mcpServers: [] });
				const restoredModel =
					(result.configOptions?.[0]?.currentValue as string | undefined) ?? ctx.state.defaultModelId;
				ctx.state.currentModelId = restoredModel;
				ctx.state.closed = false;
				ctx.renderer.flush();
				process.stdout.write(`resumed session: ${targetId}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
				// fall back to a fresh session
				const { sessionId } = await ctx.clientConn.newSession({ cwd: ctx.cwd, mcpServers: [] });
				ctx.state.sessionId = sessionId;
				ctx.state.currentModelId = ctx.state.defaultModelId || ctx.state.models[0]?.id || "";
				ctx.state.closed = false;
			}
			return false;
		}

		case "/close": {
			try {
				await ctx.clientConn.closeSession({ sessionId: ctx.state.sessionId });
				ctx.state.closed = true;
				process.stdout.write(`closed session: ${ctx.state.sessionId.slice(0, 8)}…  (use /new or /resume <id>)\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/delete": {
			const targetId = parts[1];
			if (!targetId) {
				process.stdout.write("usage: /delete <session-id>\n");
				return false;
			}
			try {
				await ctx.clientConn.extMethod(EXT_DELETE_SESSION, { sessionId: targetId });
				process.stdout.write(`deleted session: ${targetId.slice(0, 8)}…\n`);
				if (targetId === ctx.state.sessionId) {
					ctx.state.closed = true;
					// Recurse into /new so the user lands on a fresh, usable session.
					await handleCommand("/new", ctx);
				}
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/model": {
			const modelId = parts[1];
			if (!modelId) {
				for (const m of ctx.state.models) {
					const marker = m.id === ctx.state.currentModelId ? " *" : "  ";
					process.stdout.write(`${marker} ${m.id}  (${m.provider})\n`);
				}
				return false;
			}
			try {
				const result = await ctx.clientConn.setSessionConfigOption({
					sessionId: ctx.state.sessionId,
					configId: "model",
					value: modelId,
				});
				refreshStateFromConfigOptions(ctx.state, result.configOptions);
				process.stdout.write(`model switched to: ${ctx.state.currentModelId}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/compact": {
			const customInstructions = parts.slice(1).join(" ").trim() || undefined;
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_COMPACT, {
					sessionId: ctx.state.sessionId,
					...(customInstructions ? { customInstructions } : {}),
				})) as { summary?: string; tokensBefore?: number };
				const tokens = typeof result.tokensBefore === "number" ? ` (was ~${result.tokensBefore} tokens)` : "";
				process.stdout.write(`compacted${tokens}\n${result.summary ?? ""}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/entries": {
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_ENTRIES, {
					sessionId: ctx.state.sessionId,
				})) as { entries: { id: string; role: string; preview: string }[] };
				if (result.entries.length === 0) {
					process.stdout.write("  (no message entries)\n");
				} else {
					for (const e of result.entries) {
						process.stdout.write(`  ${e.id}  ${e.role.padEnd(9)} ${e.preview}\n`);
					}
				}
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/tree": {
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_TREE, {
					sessionId: ctx.state.sessionId,
				})) as {
					leafId: string | null;
					nodes: {
						id: string;
						parentId: string | null;
						type: string;
						role?: string;
						preview?: string;
						isLeaf: boolean;
					}[];
				};
				if (result.nodes.length === 0) {
					process.stdout.write("  (empty session)\n");
				} else {
					for (const n of result.nodes) {
						const marker = n.isLeaf ? "*" : " ";
						const role = n.role ?? n.type;
						const preview = n.preview ?? "";
						process.stdout.write(`${marker} ${n.id}  ${role.padEnd(9)} ${preview}\n`);
					}
				}
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/goto": {
			const targetEntryId = parts[1];
			if (!targetEntryId) {
				process.stdout.write("usage: /goto <entry-id>\n");
				return false;
			}
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_NAVIGATE, {
					sessionId: ctx.state.sessionId,
					targetEntryId,
				})) as { leafId: string };
				process.stdout.write(`leaf moved to: ${result.leafId}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/fork": {
			const entryId = parts[1];
			if (!entryId) {
				process.stdout.write("usage: /fork <entry-id>\n");
				return false;
			}
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_FORK, {
					sessionId: ctx.state.sessionId,
					entryId,
					position: "before",
				})) as { newSessionId: string; selectedText?: string };
				process.stdout.write(`forked: ${result.newSessionId}\n`);
				if (result.selectedText) process.stdout.write(`  user message: ${result.selectedText}\n`);
				process.stdout.write(`  use /resume ${result.newSessionId} to continue from the fork\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/clone":
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_CLONE, {
					sessionId: ctx.state.sessionId,
				})) as { newSessionId: string };
				process.stdout.write(`cloned: ${result.newSessionId}\n`);
				process.stdout.write(`  use /resume ${result.newSessionId} to continue on the clone\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;

		case "/name": {
			const name = parts.slice(1).join(" ").trim();
			if (!name) {
				process.stdout.write("usage: /name <display name>\n");
				return false;
			}
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_SET_NAME, {
					sessionId: ctx.state.sessionId,
					name,
				})) as { name: string };
				process.stdout.write(`session name set to: ${result.name}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/session": {
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_STATS, {
					sessionId: ctx.state.sessionId,
				})) as { messageCount: number; toolCallCount: number; leafId: string; name?: string };
				process.stdout.write(
					[
						`  session: ${ctx.state.sessionId}`,
						...(result.name ? [`  name: ${result.name}`] : []),
						`  messages: ${result.messageCount}`,
						`  tool calls: ${result.toolCallCount}`,
						`  leaf: ${result.leafId}`,
					].join("\n"),
				);
				process.stdout.write("\n");
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/export": {
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_EXPORT, {
					sessionId: ctx.state.sessionId,
				})) as { format: string; content: string };
				process.stdout.write(`${result.content}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/config": {
			try {
				const result = (await ctx.clientConn.extMethod(EXT_SESSION_CONFIG, {
					sessionId: ctx.state.sessionId,
				})) as {
					cwd: string;
					defaultModelId: string;
					currentModelId: string;
					compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
					appendSystemPrompt: string | null;
					contextFilePaths: string[];
					projectSettingsPresent: boolean;
				};
				const lines = [
					`  cwd: ${result.cwd}`,
					`  default model: ${result.defaultModelId}`,
					`  current model: ${result.currentModelId}`,
					`  compaction.enabled: ${result.compaction.enabled}`,
					`  compaction.reserveTokens: ${result.compaction.reserveTokens}`,
					`  compaction.keepRecentTokens: ${result.compaction.keepRecentTokens}`,
					`  appendSystemPrompt: ${result.appendSystemPrompt ?? "(none)"}`,
					`  project settings present: ${result.projectSettingsPresent}`,
					`  context files: ${result.contextFilePaths.length === 0 ? "(none)" : ""}`,
					...result.contextFilePaths.map((p) => `    - ${p}`),
				];
				process.stdout.write(`${lines.join("\n")}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/settings": {
			const sub = parts[1];
			if (!sub) {
				process.stdout.write("usage: /settings list|get|set|unset ...\n");
				return false;
			}
			const tail = parts.slice(2);
			try {
				if (sub === "list") {
					const { scope } = extractScopeFlag(tail);
					const result = (await ctx.clientConn.extMethod(EXT_SESSION_SETTINGS_LIST, {
						sessionId: ctx.state.sessionId,
						...(scope ? { scope } : {}),
					})) as { scope: string; settings: Record<string, unknown> };
					process.stdout.write(`scope: ${result.scope}\n`);
					const entries = Object.entries(result.settings ?? {});
					if (entries.length === 0) process.stdout.write("  (empty)\n");
					for (const [k, v] of entries) process.stdout.write(`  ${k} = ${JSON.stringify(v)}\n`);
				} else if (sub === "get") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					if (!key) {
						process.stdout.write("usage: /settings get <key> [--scope]\n");
						return false;
					}
					const result = (await ctx.clientConn.extMethod(EXT_SESSION_SETTINGS_GET, {
						sessionId: ctx.state.sessionId,
						key,
						...(scope ? { scope } : {}),
					})) as { key: string; value: unknown; effective: unknown; source: string };
					process.stdout.write(
						`  ${result.key} = ${JSON.stringify(result.effective)}  (source: ${result.source})\n`,
					);
				} else if (sub === "set") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					const value = rest.slice(1).join(" ");
					if (!key || rest.length < 2) {
						process.stdout.write("usage: /settings set <key> <value> [--scope]\n");
						return false;
					}
					const result = (await ctx.clientConn.extMethod(EXT_SESSION_SETTINGS_SET, {
						sessionId: ctx.state.sessionId,
						key,
						value,
						...(scope ? { scope } : {}),
					})) as { scope: string; effective: unknown; configOptions?: SessionConfigOption[] };
					refreshStateFromConfigOptions(ctx.state, result.configOptions);
					process.stdout.write(
						`set ${key} (scope: ${result.scope}); effective = ${JSON.stringify(result.effective)}\n`,
					);
				} else if (sub === "unset") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					if (!key) {
						process.stdout.write("usage: /settings unset <key> [--scope]\n");
						return false;
					}
					const result = (await ctx.clientConn.extMethod(EXT_SESSION_SETTINGS_UNSET, {
						sessionId: ctx.state.sessionId,
						key,
						...(scope ? { scope } : {}),
					})) as { scope: string; effective: unknown; configOptions?: SessionConfigOption[] };
					refreshStateFromConfigOptions(ctx.state, result.configOptions);
					process.stdout.write(
						`unset ${key} (scope: ${result.scope}); effective = ${JSON.stringify(result.effective)}\n`,
					);
				} else {
					process.stdout.write(`unknown /settings subcommand: ${sub}\n`);
				}
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/login": {
			const provider = parts[1];
			const apiKey = parts.slice(2).join(" ").trim();
			if (!provider || !apiKey) {
				process.stdout.write("usage: /login <provider> <api-key>\n");
				return false;
			}
			try {
				const result = (await ctx.clientConn.extMethod(EXT_KV_SET, {
					sessionId: ctx.state.sessionId,
					key: `${AUTH_PREFIX}${provider}`,
					value: apiKey,
					secret: true,
				})) as { configOptions?: SessionConfigOption[] };
				refreshStateFromConfigOptions(ctx.state, result.configOptions);
				process.stdout.write(`stored auth for ${provider}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/logout": {
			const provider = parts[1];
			if (!provider) {
				process.stdout.write("usage: /logout <provider>\n");
				return false;
			}
			try {
				const result = (await ctx.clientConn.extMethod(EXT_KV_REMOVE, {
					sessionId: ctx.state.sessionId,
					key: `${AUTH_PREFIX}${provider}`,
				})) as { configOptions?: SessionConfigOption[] };
				refreshStateFromConfigOptions(ctx.state, result.configOptions);
				process.stdout.write(`removed auth for ${provider}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/logins": {
			try {
				const result = (await ctx.clientConn.extMethod(EXT_KV_LIST, { prefix: AUTH_PREFIX })) as {
					entries: Array<{ key: string; value: string; secret: boolean }>;
				};
				if (result.entries.length === 0) {
					process.stdout.write("  (no stored auth)\n");
				} else {
					for (const e of result.entries) {
						const provider = e.key.startsWith(AUTH_PREFIX) ? e.key.slice(AUTH_PREFIX.length) : e.key;
						process.stdout.write(`  ${provider}: ${e.value}\n`);
					}
				}
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/quit":
		case "/exit":
			return true;

		default:
			process.stdout.write(`unknown command: ${cmd}  (type /help for a list)\n`);
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
