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
				const result = await ctx.client.listSessions({});
				const sessions = result.sessions ?? [];
				if (sessions.length === 0) {
					ctx.addSystemMessage("(no sessions)");
				} else {
					const lines = ["sessions:"];
					for (const s of sessions) {
						const marker = s.sessionId === ctx.sessionId ? "*" : " ";
						const updated = formatAge(s.updatedAt);
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
