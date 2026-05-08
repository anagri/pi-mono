import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { SessionStore } from "@bodhiapp/bodhi-pi";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Renderer } from "./render.js";

export interface ReplState {
	sessionId: string;
	currentModelId: string;
	models: Model<Api>[];
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
			process.stdout.write(
				[
					"  /help              show this help",
					"  /new               start a new session",
					"  /sessions          list sessions for current cwd",
					"  /resume <id>       load a previous session (replays history)",
					"  /model <id>        switch model for current session",
					"  /quit              exit",
					"",
				].join("\n"),
			);
			return false;
		}

		case "/new": {
			await ctx.clientConn.closeSession({ sessionId: ctx.state.sessionId });
			const { sessionId } = await ctx.clientConn.newSession({ cwd: ctx.cwd, mcpServers: [] });
			ctx.state.sessionId = sessionId;
			ctx.state.currentModelId = ctx.state.models[0]?.id ?? "";
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
			await ctx.clientConn.closeSession({ sessionId: ctx.state.sessionId });
			process.stdout.write("loading session history…\n");
			ctx.state.sessionId = targetId;
			try {
				await ctx.clientConn.loadSession({ sessionId: targetId, cwd: ctx.cwd });
				ctx.renderer.flush();
				process.stdout.write(`resumed session: ${targetId}\n`);
			} catch (err) {
				process.stdout.write(`error: ${String(err)}\n`);
				// fall back to a fresh session
				const { sessionId } = await ctx.clientConn.newSession({ cwd: ctx.cwd, mcpServers: [] });
				ctx.state.sessionId = sessionId;
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

		case "/quit":
		case "/exit": {
			return true;
		}

		default: {
			process.stdout.write(`unknown command: ${cmd}  (type /help for a list)\n`);
			return false;
		}
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
