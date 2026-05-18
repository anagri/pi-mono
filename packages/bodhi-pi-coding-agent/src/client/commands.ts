import type { AvailableCommand, SessionConfigOption } from "@agentclientprotocol/sdk";
import {
	type BodhiPiClient,
	formatProviderAuth,
	type ModelOption,
	modelConfigFromOptions,
	parseLoginArgs,
	type SessionStore,
} from "@bodhiapp/bodhi-pi";

export interface CmdState {
	sessionId: string;
	currentModelId: string;
	defaultModelId: string;
	models: ModelOption[];
	availableCommands: AvailableCommand[];
	closed: boolean;
}

export interface CommandContext {
	client: BodhiPiClient;
	state: CmdState;
	sessionStore: SessionStore;
	cwd: string;
	write: (text: string) => void;
}

export function isCommand(line: string): boolean {
	return line.startsWith("/");
}

export function refreshStateFromConfigOptions(
	state: CmdState,
	options: readonly SessionConfigOption[] | undefined,
): void {
	const next = modelConfigFromOptions(options);
	if (next.models.length === 0 && !next.currentModelId) return;
	state.models = next.models;
	state.currentModelId = next.currentModelId || state.currentModelId;
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

function formatAge(ms: number): string {
	const diff = Date.now() - ms;
	const min = Math.floor(diff / 60000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

export const BUILTIN_COMMANDS: AvailableCommand[] = [
	{ name: "help", description: "show available commands" },
	{ name: "new", description: "start a new session" },
	{ name: "sessions", description: "list sessions for current cwd" },
	{ name: "resume", description: "load a previous session", input: { hint: "session-id" } },
	{ name: "close", description: "close the current session" },
	{ name: "delete", description: "permanently delete a session", input: { hint: "session-id" } },
	{ name: "model", description: "switch model or list models", input: { hint: "model-id" } },
	{ name: "compact", description: "summarize earlier turns", input: { hint: "hint" } },
	{ name: "entries", description: "list message entry ids on current branch" },
	{ name: "tree", description: "show the full session DAG" },
	{ name: "goto", description: "move leaf to entry", input: { hint: "entry-id" } },
	{ name: "fork", description: "fork before entry", input: { hint: "entry-id" } },
	{ name: "clone", description: "clone the current session" },
	{ name: "name", description: "set session display name", input: { hint: "text" } },
	{ name: "session", description: "show session stats" },
	{ name: "export", description: "print session as JSONL to stdout" },
	{ name: "config", description: "show resolved per-session config" },
	{ name: "settings", description: "manage settings", input: { hint: "list|get|set|unset ..." } },
	{ name: "login", description: "store provider auth", input: { hint: "provider [api_key=...]" } },
	{ name: "logout", description: "remove provider auth", input: { hint: "provider" } },
	{ name: "logins", description: "list providers with stored auth" },
	{ name: "quit", description: "exit" },
];

export async function handleCommand(line: string, ctx: CommandContext): Promise<boolean> {
	const parts = line.trim().split(/\s+/);
	const cmd = parts[0];
	const { write } = ctx;

	switch (cmd) {
		case "/help": {
			const lines = [
				"  /help              show this help",
				"  /new               start a new session",
				"  /sessions          list sessions for current cwd",
				"  /resume <id>       load a previous session",
				"  /close             close the current session",
				"  /delete <id>       permanently delete a session",
				"  /model [id]        list or switch model",
				"  /compact [hint]    summarize earlier turns",
				"  /entries           list message entry ids on current branch",
				"  /tree              show the full session DAG",
				"  /goto <entryId>    move the leaf to entry",
				"  /fork <entryId>    fork before entry",
				"  /clone             clone the current session at the leaf",
				"  /name <text>       set the session display name",
				"  /session           show session stats",
				"  /export            print the session as JSONL",
				"  /config            show resolved per-session config",
				"  /settings list|get|set|unset <key> [value] [--global|--project|--session]",
				'  /login <provider> [api_key="..."] [base_url="..."]',
				"  /logout <provider>",
				"  /logins",
				"  /quit              exit",
			];
			if (ctx.state.availableCommands.length > 0) {
				lines.push("", "  agent slash commands:");
				for (const c of ctx.state.availableCommands) {
					const hint = c.input ? ` <${c.input.hint ?? "input"}>` : "";
					const label = `  /${c.name}${hint}`;
					lines.push(`${label.padEnd(22)} ${c.description}`);
				}
			}
			write(`${lines.join("\n")}\n`);
			return false;
		}

		case "/new": {
			if (!ctx.state.closed && ctx.state.sessionId) {
				try {
					await ctx.client.closeSession({ sessionId: ctx.state.sessionId });
				} catch {
					// already closed
				}
			}
			const { sessionId, configOptions } = await ctx.client.newSession({ cwd: ctx.cwd, mcpServers: [] });
			refreshStateFromConfigOptions(ctx.state, configOptions ?? undefined);
			ctx.state.sessionId = sessionId;
			ctx.state.currentModelId = ctx.state.defaultModelId || ctx.state.models[0]?.id || "";
			ctx.state.closed = false;
			write(`new session: ${sessionId}\n`);
			return false;
		}

		case "/sessions": {
			let cursor: string | undefined;
			let total = 0;
			const lines: string[] = [];
			do {
				const result = await ctx.sessionStore.list({ cwd: ctx.cwd, ...(cursor ? { cursor } : {}) });
				for (const s of result.sessions) {
					const ago = formatAge(s.updatedAt);
					const active = s.sessionId === ctx.state.sessionId ? " *" : "";
					lines.push(`  ${s.sessionId.slice(0, 8)}…  ${s.messageCount} msgs  ${ago}${active}`);
				}
				total += result.sessions.length;
				cursor = result.nextCursor;
			} while (cursor);
			if (total === 0) lines.push("  (no sessions for this directory)");
			write(`${lines.join("\n")}\n`);
			return false;
		}

		case "/resume": {
			const targetId = parts[1];
			if (!targetId) {
				write("usage: /resume <session-id>\n");
				return false;
			}
			if (!ctx.state.closed && ctx.state.sessionId && ctx.state.sessionId !== targetId) {
				try {
					await ctx.client.closeSession({ sessionId: ctx.state.sessionId });
				} catch {
					// already closed
				}
			}
			ctx.state.sessionId = targetId;
			try {
				const result = await ctx.client.loadSession({ sessionId: targetId, cwd: ctx.cwd, mcpServers: [] });
				refreshStateFromConfigOptions(ctx.state, result.configOptions ?? undefined);
				ctx.state.currentModelId = ctx.state.currentModelId || ctx.state.defaultModelId;
				ctx.state.closed = false;
				write(`resumed session: ${targetId}\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
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
				write(`closed session: ${ctx.state.sessionId.slice(0, 8)}…  (use /new or /resume <id>)\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/delete": {
			const targetId = parts[1];
			if (!targetId) {
				write("usage: /delete <session-id>\n");
				return false;
			}
			try {
				await ctx.client.deleteSession({ sessionId: targetId });
				write(`deleted: ${targetId.slice(0, 8)}…\n`);
				if (targetId === ctx.state.sessionId) {
					ctx.state.closed = true;
					await handleCommand("/new", ctx);
				}
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/model": {
			const modelId = parts[1];
			if (!modelId) {
				const lines = ctx.state.models.map((m) => {
					const marker = m.id === ctx.state.currentModelId ? " *" : "  ";
					return `${marker} ${m.id}`;
				});
				write(`${lines.join("\n") || "  (no models available)"}\n`);
				return false;
			}
			try {
				await ctx.client.model(modelId, { sessionId: ctx.state.sessionId });
				const next = ctx.client.models();
				ctx.state.models = next.models;
				ctx.state.currentModelId = next.currentModelId || modelId;
				write(`model: ${ctx.state.currentModelId}\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
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
				write(`compacted${tokens}\n${result.summary ?? ""}\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/entries": {
			try {
				const result = await ctx.client.listSessionEntries({ sessionId: ctx.state.sessionId });
				if (result.entries.length === 0) {
					write("  (no message entries)\n");
				} else {
					const lines = result.entries.map((e) => `  ${e.id}  ${e.role.padEnd(9)} ${e.preview}`);
					write(lines.join("\n") + "\n");
				}
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/tree": {
			try {
				const result = await ctx.client.getSessionTree({ sessionId: ctx.state.sessionId });
				if (result.nodes.length === 0) {
					write("  (empty session)\n");
				} else {
					const lines = result.nodes.map((n) => {
						const marker = n.isLeaf ? "*" : " ";
						const role = n.role ?? n.type;
						const preview = n.preview ?? "";
						return `${marker} ${n.id}  ${role.padEnd(9)} ${preview}`;
					});
					write(lines.join("\n") + "\n");
				}
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/goto": {
			const targetEntryId = parts[1];
			if (!targetEntryId) {
				write("usage: /goto <entry-id>\n");
				return false;
			}
			try {
				const result = await ctx.client.navigateSession({ sessionId: ctx.state.sessionId, targetEntryId });
				write(`leaf moved to: ${result.leafId}\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/fork": {
			const entryId = parts[1];
			if (!entryId) {
				write("usage: /fork <entry-id>\n");
				return false;
			}
			try {
				const result = await ctx.client.forkSession({
					sessionId: ctx.state.sessionId,
					entryId,
					position: "before",
				});
				write(`forked: ${result.newSessionId}\n  use /resume ${result.newSessionId} to continue\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/clone": {
			try {
				const result = await ctx.client.cloneSession({ sessionId: ctx.state.sessionId });
				write(`cloned: ${result.newSessionId}\n  use /resume ${result.newSessionId} to continue\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/name": {
			const name = parts.slice(1).join(" ").trim();
			if (!name) {
				write("usage: /name <display name>\n");
				return false;
			}
			try {
				const result = await ctx.client.setSessionName({ sessionId: ctx.state.sessionId, name });
				write(`session name: ${result.name}\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/session": {
			try {
				const result = await ctx.client.getSessionStats({ sessionId: ctx.state.sessionId });
				const lines = [
					`  session: ${ctx.state.sessionId}`,
					...(result.name ? [`  name: ${result.name}`] : []),
					`  messages: ${result.messageCount}`,
					`  tool calls: ${result.toolCallCount}`,
					`  leaf: ${result.leafId}`,
				];
				write(lines.join("\n") + "\n");
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/export": {
			try {
				const result = await ctx.client.exportSession({ sessionId: ctx.state.sessionId });
				process.stdout.write(`${result.content}\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/config": {
			try {
				const result = await ctx.client.getSessionConfig({ sessionId: ctx.state.sessionId });
				const lines = [
					`  cwd: ${result.cwd}`,
					`  default model: ${result.defaultModelId}`,
					`  current model: ${result.currentModelId}`,
					`  compaction.enabled: ${result.compaction.enabled}`,
					`  compaction.reserveTokens: ${result.compaction.reserveTokens}`,
					`  appendSystemPrompt: ${result.appendSystemPrompt ?? "(none)"}`,
					`  context files: ${result.contextFilePaths.length === 0 ? "(none)" : ""}`,
					...result.contextFilePaths.map((p) => `    - ${p}`),
				];
				write(lines.join("\n") + "\n");
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/settings": {
			const sub = parts[1];
			if (!sub) {
				write("usage: /settings list|get|set|unset ...\n");
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
					const entries = Object.entries(result.settings ?? {});
					const lines = [
						`scope: ${result.scope}`,
						...(entries.length === 0 ? ["  (empty)"] : entries.map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)),
					];
					write(lines.join("\n") + "\n");
				} else if (sub === "get") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					if (!key) {
						write("usage: /settings get <key>\n");
						return false;
					}
					const result = await ctx.client.settings.get({
						sessionId: ctx.state.sessionId,
						key,
						...(scope ? { scope } : {}),
					});
					write(`  ${result.key} = ${JSON.stringify(result.effective)}  (source: ${result.source})\n`);
				} else if (sub === "set") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					const value = rest.slice(1).join(" ");
					if (!key || rest.length < 2) {
						write("usage: /settings set <key> <value>\n");
						return false;
					}
					const result = await ctx.client.settings.set({
						sessionId: ctx.state.sessionId,
						key,
						value,
						...(scope ? { scope } : {}),
					});
					write(`set ${key} (scope: ${result.scope}); effective = ${JSON.stringify(result.effective)}\n`);
				} else if (sub === "unset") {
					const { scope, rest } = extractScopeFlag(tail);
					const key = rest[0];
					if (!key) {
						write("usage: /settings unset <key>\n");
						return false;
					}
					const result = await ctx.client.settings.unset({
						sessionId: ctx.state.sessionId,
						key,
						...(scope ? { scope } : {}),
					});
					write(`unset ${key} (scope: ${result.scope}); effective = ${JSON.stringify(result.effective)}\n`);
				} else {
					write(`unknown /settings subcommand: ${sub}\n`);
				}
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/login": {
			const parsed = parseLoginArgs(parts.slice(1).join(" "));
			if ("error" in parsed) {
				write(`${parsed.error}\n`);
				return false;
			}
			try {
				await ctx.client.addProvider(parsed.provider, parsed.config, { sessionId: ctx.state.sessionId });
				write(`stored auth for ${parsed.provider}\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/logout": {
			const provider = parts[1];
			if (!provider) {
				write("usage: /logout <provider>\n");
				return false;
			}
			try {
				await ctx.client.removeProvider(provider, { sessionId: ctx.state.sessionId });
				write(`removed auth for ${provider}\n`);
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/logins": {
			try {
				const providers = await ctx.client.listProviders();
				if (providers.length === 0) {
					write("  (no stored auth)\n");
				} else {
					const lines = providers.map((e) => `  ${e.provider}: ${formatProviderAuth(e.config)}`);
					write(lines.join("\n") + "\n");
				}
			} catch (err) {
				write(`error: ${String(err)}\n`);
			}
			return false;
		}

		case "/quit":
		case "/exit":
			return true;

		default:
			write(`unknown command: ${cmd}  (type /help for a list)\n`);
			return false;
	}
}
