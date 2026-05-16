import type { AvailableCommand, SessionConfigOption } from "@agentclientprotocol/sdk";
import {
	type BodhiPiClient,
	formatProviderAuth,
	type McpAuthMode,
	type ModelOption,
	modelConfigFromOptions,
	parseLoginArgs,
	type SessionStore,
} from "@bodhiapp/bodhi-pi";
import type { Renderer } from "./render.js";

/** Parse `/mcp add` args: positional `url=…` or `command=…` plus optional `auth=`, `label=`, `header_*`, `env_*`. */
function parseMcpAddArgs(rest: string[]): {
	url?: string;
	command?: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	auth?: { mode: McpAuthMode; headers?: Array<{ name: string; value: string }> };
	label?: string;
	error?: string;
} {
	const out: ReturnType<typeof parseMcpAddArgs> = {};
	const headers: Array<{ name: string; value: string }> = [];
	for (const tok of rest) {
		const m = /^([a-zA-Z_][\w-]*)=(.*)$/.exec(tok);
		if (!m) continue;
		const key = m[1]!;
		const raw = m[2]!;
		const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
		if (key === "url") out.url = value;
		else if (key === "command") out.command = value;
		else if (key === "label") out.label = value;
		else if (key === "args") {
			try {
				const parsed = JSON.parse(value);
				if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) out.args = parsed as string[];
				else out.error = `args must be a JSON string[]`;
			} catch {
				// Treat unquoted args as space-split fallback for ergonomics.
				out.args = value.split(/\s+/).filter((s) => s.length > 0);
			}
		} else if (key === "auth") {
			if (
				value === "public" ||
				value === "header" ||
				value === "query" ||
				value === "oauth-dcr" ||
				value === "oauth-preregistered"
			) {
				out.auth = { mode: value };
			} else {
				out.error = `unknown auth mode: ${value}`;
			}
		} else if (key.startsWith("header_")) {
			headers.push({ name: key.slice("header_".length), value });
		} else if (key.startsWith("env_")) {
			out.env = out.env ?? [];
			out.env.push({ name: key.slice("env_".length), value });
		} else if (key === "api_key") {
			headers.push({ name: "Authorization", value: `Bearer ${value}` });
			out.auth = out.auth ?? { mode: "header" };
		}
	}
	if (headers.length > 0) {
		out.auth = out.auth ?? { mode: "header" };
		out.auth.headers = headers;
	}
	if (!out.url && !out.command) out.error = "expected url=<url> or command=<cmd>";
	return out;
}

export interface ReplState {
	sessionId: string;
	currentModelId: string;
	defaultModelId: string;
	models: ModelOption[];
	availableCommands: AvailableCommand[];
	closed: boolean;
}

export interface CommandContext {
	client: BodhiPiClient;
	state: ReplState;
	sessionStore: SessionStore;
	renderer: Renderer;
	cwd: string;
}

export function isCommand(line: string): boolean {
	return line.startsWith("/");
}

/**
 * Update `state.models`/`currentModelId` from a fresh `configOptions[]` payload.
 * Called from the `config_option_update` sessionUpdate handler in `repl.ts`,
 * and from `loadSession`'s response (stable ACP) on `/resume`. Non-destructive —
 * silently no-ops if no `model` option is present.
 */
export function refreshStateFromConfigOptions(
	state: ReplState,
	options: readonly SessionConfigOption[] | undefined,
): void {
	const next = modelConfigFromOptions(options);
	if (next.models.length === 0 && !next.currentModelId) return;
	state.models = next.models;
	state.currentModelId = next.currentModelId || state.currentModelId;
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
				'  /login <provider> [api_key="..."] [base_url="..."]   store provider auth',
				"  /logout <provider>            remove stored auth",
				"  /logins                       list providers with stored auth (masked)",
				"  /mcps                         list configured MCPs (slug, status)",
				"  /mcp add url=<url> [auth=public|header|...] [api_key=…] [label=…]",
				"  /mcp add command=<cmd> [args=<json>] [env_KEY=…] [label=…]",
				"  /mcp connect <slug>           connect MCP for this session",
				"  /mcp disconnect <slug>        disconnect MCP for this session",
				"  /mcp reconnect <slug>         disconnect+connect",
				"  /mcp remove <slug>            remove MCP entry from KV",
				"  /mcp tools <slug>             list tools currently exposed by an MCP",
				"  /mcp logout <slug>            clear stored OAuth tokens for an MCP",
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
					await ctx.client.closeSession({ sessionId: ctx.state.sessionId });
				} catch {
					// Already-closed sessions throw; safe to ignore.
				}
			}
			const { sessionId, configOptions } = await ctx.client.newSession({ cwd: ctx.cwd, mcpServers: [] });
			refreshStateFromConfigOptions(ctx.state, configOptions ?? undefined);
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
					await ctx.client.closeSession({ sessionId: ctx.state.sessionId });
				} catch {
					// already closed; ignore
				}
			}
			process.stdout.write("loading session history…\n");
			ctx.state.sessionId = targetId;
			try {
				const result = await ctx.client.loadSession({ sessionId: targetId, cwd: ctx.cwd, mcpServers: [] });
				refreshStateFromConfigOptions(ctx.state, result.configOptions ?? undefined);
				ctx.state.currentModelId = ctx.state.currentModelId || ctx.state.defaultModelId;
				ctx.state.closed = false;
				ctx.renderer.flush();
				process.stdout.write(`resumed session: ${targetId}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
				// fall back to a fresh session
				const { sessionId, configOptions } = await ctx.client.newSession({ cwd: ctx.cwd, mcpServers: [] });
				refreshStateFromConfigOptions(ctx.state, configOptions ?? undefined);
				ctx.state.sessionId = sessionId;
				ctx.state.currentModelId = ctx.state.defaultModelId || ctx.state.models[0]?.id || "";
				ctx.state.closed = false;
			}
			return false;
		}

		case "/close": {
			try {
				await ctx.client.closeSession({ sessionId: ctx.state.sessionId });
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
				await ctx.client.deleteSession({ sessionId: targetId });
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
					process.stdout.write(`${marker} ${m.id}\n`);
				}
				return false;
			}
			try {
				await ctx.client.model(modelId, { sessionId: ctx.state.sessionId });
				const next = ctx.client.models();
				ctx.state.models = next.models;
				ctx.state.currentModelId = next.currentModelId || modelId;
				process.stdout.write(`model switched to: ${ctx.state.currentModelId}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/compact": {
			const customInstructions = parts.slice(1).join(" ").trim() || undefined;
			try {
				const result = await ctx.client.compactSession({
					sessionId: ctx.state.sessionId,
					...(customInstructions ? { customInstructions } : {}),
				});
				const tokens = typeof result.tokensBefore === "number" ? ` (was ~${result.tokensBefore} tokens)` : "";
				process.stdout.write(`compacted${tokens}\n${result.summary ?? ""}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/entries": {
			try {
				const result = await ctx.client.listSessionEntries({
					sessionId: ctx.state.sessionId,
				});
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
				const result = await ctx.client.getSessionTree({
					sessionId: ctx.state.sessionId,
				});
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
				const result = await ctx.client.navigateSession({
					sessionId: ctx.state.sessionId,
					targetEntryId,
				});
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
				const result = await ctx.client.forkSession({
					sessionId: ctx.state.sessionId,
					entryId,
					position: "before",
				});
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
				const result = await ctx.client.cloneSession({
					sessionId: ctx.state.sessionId,
				});
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
				const result = await ctx.client.setSessionName({
					sessionId: ctx.state.sessionId,
					name,
				});
				process.stdout.write(`session name set to: ${result.name}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/session": {
			try {
				const result = await ctx.client.getSessionStats({
					sessionId: ctx.state.sessionId,
				});
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
				const result = await ctx.client.exportSession({
					sessionId: ctx.state.sessionId,
				});
				process.stdout.write(`${result.content}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/config": {
			try {
				const result = await ctx.client.getSessionConfig({
					sessionId: ctx.state.sessionId,
				});
				const lines = [
					`  cwd: ${result.cwd}`,
					`  default model: ${result.defaultModelId}`,
					`  current model: ${result.currentModelId}`,
					`  compaction.enabled: ${result.compaction.enabled}`,
					`  compaction.reserveTokens: ${result.compaction.reserveTokens}`,
					`  compaction.keepRecentTokens: ${result.compaction.keepRecentTokens}`,
					`  appendSystemPrompt: ${result.appendSystemPrompt ?? "(none)"}`,
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
					const result = await ctx.client.settings.list({
						sessionId: ctx.state.sessionId,
						...(scope ? { scope } : {}),
					});
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
					const result = await ctx.client.settings.get({
						sessionId: ctx.state.sessionId,
						key,
						...(scope ? { scope } : {}),
					});
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
					const result = await ctx.client.settings.set({
						sessionId: ctx.state.sessionId,
						key,
						value,
						...(scope ? { scope } : {}),
					});
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
					const result = await ctx.client.settings.unset({
						sessionId: ctx.state.sessionId,
						key,
						...(scope ? { scope } : {}),
					});
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
			const parsed = parseLoginArgs(parts.slice(1).join(" "));
			if ("error" in parsed) {
				process.stdout.write(`${parsed.error}\n`);
				return false;
			}
			try {
				await ctx.client.addProvider(parsed.provider, parsed.config, { sessionId: ctx.state.sessionId });
				process.stdout.write(`stored auth for ${parsed.provider}\n`);
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
				await ctx.client.removeProvider(provider, { sessionId: ctx.state.sessionId });
				// Picker state refresh arrives via `config_option_update` sessionUpdate.
				process.stdout.write(`removed auth for ${provider}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/logins": {
			try {
				const providers = await ctx.client.listProviders();
				if (providers.length === 0) {
					process.stdout.write("  (no stored auth)\n");
				} else {
					for (const entry of providers) {
						process.stdout.write(`  ${entry.provider}: ${formatProviderAuth(entry.config)}\n`);
					}
				}
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/mcps": {
			try {
				const entries = await ctx.client.mcpList();
				if (entries.length === 0) {
					process.stdout.write("  (no MCPs configured)\n");
				} else {
					for (const e of entries) {
						const target = e.url ?? e.command ?? "?";
						process.stdout.write(
							`  ${e.slug.padEnd(20)} ${e.status.padEnd(13)} ${e.transport.padEnd(6)} ${target}\n`,
						);
					}
				}
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/mcp": {
			const sub = parts[1];
			const rest = parts.slice(2);
			if (sub === "add") {
				const parsed = parseMcpAddArgs(rest);
				if (parsed.error) {
					process.stdout.write(`${parsed.error}\n`);
					return false;
				}
				try {
					const result = parsed.url
						? await ctx.client.mcpAdd({
								url: parsed.url,
								...(parsed.auth ? { auth: parsed.auth } : {}),
								...(parsed.label ? { label: parsed.label } : {}),
							})
						: await ctx.client.mcpAdd({
								command: parsed.command!,
								...(parsed.args ? { args: parsed.args } : {}),
								...(parsed.env ? { env: parsed.env } : {}),
								...(parsed.label ? { label: parsed.label } : {}),
							});
					process.stdout.write(`added: ${result.slug}\n`);
				} catch (err) {
					process.stdout.write(`error: ${String(err)}\n`);
				}
				return false;
			}
			const slug = rest[0];
			if (!slug) {
				process.stdout.write(
					"usage: /mcp <add|connect|disconnect|reconnect|remove|include|exclude|tools> [args…]\n",
				);
				return false;
			}
			try {
				if (sub === "connect") {
					const result = await ctx.client.mcpConnect({ slug });
					process.stdout.write(`connected ${slug}: ${result.tools.join(", ") || "(no tools)"}\n`);
				} else if (sub === "disconnect") {
					await ctx.client.mcpDisconnect({ slug });
					process.stdout.write(`disconnected ${slug}\n`);
				} else if (sub === "reconnect") {
					const result = await ctx.client.mcpReconnect({ slug });
					process.stdout.write(`reconnected ${slug}: ${result.tools.join(", ") || "(no tools)"}\n`);
				} else if (sub === "remove") {
					await ctx.client.mcpRemove({ slug });
					process.stdout.write(`removed ${slug}\n`);
				} else if (sub === "include") {
					const result = await ctx.client.mcpInclude({ slug, sessionId: ctx.state.sessionId });
					process.stdout.write(`included ${slug}: ${result.tools.join(", ") || "(no tools visible)"}\n`);
				} else if (sub === "exclude") {
					await ctx.client.mcpExclude({ slug, sessionId: ctx.state.sessionId });
					process.stdout.write(`excluded ${slug}\n`);
				} else if (sub === "tools") {
					const tools = await ctx.client.mcpTools({ slug, sessionId: ctx.state.sessionId });
					if (tools.length === 0) {
						process.stdout.write(`  (no tools — is ${slug} connected and included?)\n`);
					} else {
						for (const t of tools) process.stdout.write(`  ${t}\n`);
					}
				} else if (sub === "logout") {
					const existing = await ctx.client.kv.get({ key: `mcp/${slug}` });
					const v = existing.value;
					if (v && typeof v === "object" && !Array.isArray(v)) {
						const obj = { ...(v as Record<string, unknown>) };
						const auth = obj.auth;
						if (auth && typeof auth === "object" && !Array.isArray(auth)) {
							const next = { ...(auth as Record<string, unknown>) };
							delete next.tokens;
							obj.auth = next;
						}
						await ctx.client.kv.set({ sessionId: ctx.state.sessionId, key: `mcp/${slug}`, value: obj as never });
						process.stdout.write(`cleared OAuth tokens for ${slug}\n`);
					} else {
						process.stdout.write(`  (unknown mcp: ${slug})\n`);
					}
				} else {
					process.stdout.write(`unknown /mcp sub-command: ${sub ?? "?"}\n`);
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
