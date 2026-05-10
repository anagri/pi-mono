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
	listSessions?: (params: { cwd?: string }) => Promise<{
		sessions: { sessionId: string; cwd: string; updatedAt?: number }[];
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
				const result = await c.listSessions({});
				const sessions = result.sessions ?? [];
				if (sessions.length === 0) {
					ctx.addSystemMessage("(no sessions)");
				} else {
					const lines = ["sessions:"];
					for (const s of sessions) {
						const marker = s.sessionId === ctx.sessionId ? "*" : " ";
						const updated = typeof s.updatedAt === "number" ? formatAge(s.updatedAt) : "";
						lines.push(`${marker} ${s.sessionId}  ${updated}`);
					}
					ctx.addSystemMessage(lines.join("\n"));
				}
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
