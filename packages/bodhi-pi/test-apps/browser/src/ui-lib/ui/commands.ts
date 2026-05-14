import type { AvailableCommand, ClientSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";

/**
 * Local slash dispatcher for the shared test-app UI. Operates on the raw
 * `ClientSideConnection` (not the publishable `BodhiPiClient`) so it stays
 * importable from the `e2e/` tree without violating the no-sibling-package
 * rule documented in `packages/bodhi-pi/e2e/CLAUDE.md`.
 *
 * Precedence rule (see plan `ai-docs/plans/follow-up-to-commit-5cacab30-*.md`):
 *   1. Non-slash → caller forwards to session/prompt.
 *   2. Slash whose name is in `availableCommands` → agent-side; caller forwards.
 *   3. Slash whose name is in this registry → handled locally here.
 *   4. Unknown slash → caller forwards verbatim (agent treats as literal text).
 */

const MODEL_CONFIG_ID = "model";
const EXT_SESSION_FORK = "_bodhi-pi/session/fork";
const EXT_SESSION_CLONE = "_bodhi-pi/session/clone";

export interface SlashState {
	sessionId: string;
	availableCommands: AvailableCommand[];
}

export interface SlashContext {
	conn: ClientSideConnection;
	cwd: string;
	state: SlashState;
	pushSystemMessage(text: string, dataAttrs?: Record<string, string>): void;
	setSessionId(id: string): void;
	setCurrentModel(id: string): void;
}

export type SlashOutcome = { handled: boolean };

export function isSlash(line: string): boolean {
	return line.trim().startsWith("/");
}

function commandName(line: string): string {
	const head = line.trim().split(/\s+/, 1)[0] ?? "";
	return head.startsWith("/") ? head.slice(1) : head;
}

export function extractModelFromConfigOptions(options: SessionConfigOption[] | null | undefined): string | undefined {
	if (!options) return undefined;
	for (const opt of options) {
		if (opt.id === MODEL_CONFIG_ID && typeof opt.currentValue === "string") return opt.currentValue;
	}
	return undefined;
}

export async function tryHandleSlash(line: string, ctx: SlashContext): Promise<SlashOutcome> {
	if (!isSlash(line)) return { handled: false };
	const name = commandName(line);
	if (ctx.state.availableCommands.some((c) => c.name === name)) return { handled: false };

	const parts = line.trim().split(/\s+/);
	const cmd = parts[0];

	switch (cmd) {
		case "/model": {
			const modelId = parts[1];
			if (!modelId) {
				ctx.pushSystemMessage("usage: /model <id>");
				return { handled: true };
			}
			try {
				const result = await ctx.conn.setSessionConfigOption({
					sessionId: ctx.state.sessionId,
					configId: MODEL_CONFIG_ID,
					value: modelId,
				});
				const next = extractModelFromConfigOptions(result.configOptions);
				if (next) ctx.setCurrentModel(next);
				ctx.pushSystemMessage(`model switched to: ${next ?? modelId}`);
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/sessions": {
			try {
				const result = await ctx.conn.listSessions({ cwd: ctx.cwd });
				if (result.sessions.length === 0) {
					ctx.pushSystemMessage("(no sessions for this cwd)");
				} else {
					const lines = ["sessions:"];
					for (const s of result.sessions) {
						const marker = s.sessionId === ctx.state.sessionId ? "*" : " ";
						lines.push(`${marker} ${s.sessionId}`);
					}
					ctx.pushSystemMessage(lines.join("\n"));
				}
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/new": {
			try {
				if (ctx.state.sessionId) {
					try {
						await ctx.conn.closeSession({ sessionId: ctx.state.sessionId });
					} catch {
						// best-effort — don't block /new on a stale session
					}
				}
				const result = await ctx.conn.newSession({ cwd: ctx.cwd, mcpServers: [] });
				ctx.setSessionId(result.sessionId);
				const m = extractModelFromConfigOptions(result.configOptions);
				if (m) ctx.setCurrentModel(m);
				ctx.pushSystemMessage(`new session: ${result.sessionId}`);
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/resume": {
			const targetId = parts[1];
			if (!targetId) {
				ctx.pushSystemMessage("usage: /resume <session-id>");
				return { handled: true };
			}
			try {
				if (ctx.state.sessionId && ctx.state.sessionId !== targetId) {
					try {
						await ctx.conn.closeSession({ sessionId: ctx.state.sessionId });
					} catch {
						// best-effort
					}
				}
				const result = await ctx.conn.loadSession({ sessionId: targetId, cwd: ctx.cwd, mcpServers: [] });
				ctx.setSessionId(targetId);
				const m = extractModelFromConfigOptions(result.configOptions);
				if (m) ctx.setCurrentModel(m);
				ctx.pushSystemMessage(`resumed session: ${targetId}`, {
					"data-session-event": "resumed",
					"data-session-id": targetId,
				});
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/close": {
			try {
				await ctx.conn.closeSession({ sessionId: ctx.state.sessionId });
				ctx.pushSystemMessage(`closed session: ${ctx.state.sessionId}`, {
					"data-session-event": "closed",
					"data-session-id": ctx.state.sessionId,
				});
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/fork": {
			const entryId = parts[1];
			if (!entryId) {
				ctx.pushSystemMessage("usage: /fork <entry-id>");
				return { handled: true };
			}
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_FORK, {
					sessionId: ctx.state.sessionId,
					entryId,
					position: "before",
				})) as { newSessionId?: string };
				ctx.pushSystemMessage(`forked: ${result.newSessionId ?? ""}`);
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		case "/clone": {
			try {
				const result = (await ctx.conn.extMethod(EXT_SESSION_CLONE, {
					sessionId: ctx.state.sessionId,
				})) as { newSessionId?: string };
				ctx.pushSystemMessage(`cloned: ${result.newSessionId ?? ""}`, {
					"data-session-event": "cloned",
					"data-session-id": result.newSessionId ?? "",
				});
			} catch (err) {
				ctx.pushSystemMessage(`error: ${(err as Error).message ?? String(err)}`);
			}
			return { handled: true };
		}

		default:
			return { handled: false };
	}
}
