import type { AvailableCommand, ClientSideConnection } from "@agentclientprotocol/sdk";
import {
	EXT_DELETE_SESSION,
	EXT_SESSION_CLONE,
	EXT_SESSION_COMPACT,
	EXT_SESSION_ENTRIES,
	EXT_SESSION_EXPORT,
	EXT_SESSION_FORK,
	EXT_SESSION_NAVIGATE,
	EXT_SESSION_SET_NAME,
	EXT_SESSION_STATS,
	EXT_SESSION_TREE,
	type SessionStore,
} from "@bodhiapp/bodhi-pi";
import type { Api, Model } from "@mariozechner/pi-ai";
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
			const result = await ctx.sessionStore.list({ cwd: ctx.cwd });
			if (result.sessions.length === 0) {
				process.stdout.write("  (no sessions for this directory)\n");
			} else {
				for (const s of result.sessions) {
					const ago = formatAge(s.updatedAt);
					const active = s.sessionId === ctx.state.sessionId ? " *" : "";
					process.stdout.write(`  ${s.sessionId.slice(0, 8)}…  ${s.messageCount} msgs  ${ago}${active}\n`);
				}
				if (result.nextCursor) process.stdout.write("  (more — use /sessions with cursor support TBD)\n");
			}
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
				const newId = result.configOptions[0]?.currentValue ?? modelId;
				ctx.state.currentModelId = newId;
				process.stdout.write(`model switched to: ${newId}\n`);
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
