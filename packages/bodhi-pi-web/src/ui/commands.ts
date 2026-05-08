import type { AvailableCommand, ClientSideConnection } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ChatState } from "../store/chatStore";

/**
 * Slash-command dispatcher for bodhi-pi-web. Ported from
 * `bodhi-pi-cli/src/repl/commands.ts` — same `clientConn`/state surface,
 * different sink (system messages instead of stdout). M4 ships /help and
 * /model only; M5 adds /sessions, /new, /resume, /close, /delete.
 */

export interface UiCommandState {
	sessionId: string;
	currentModelId: string;
	models: Model<Api>[];
	availableCommands: AvailableCommand[];
}

export interface UiCommandContext {
	conn: ClientSideConnection;
	state: UiCommandState;
	addSystemMessage: ChatState["addSystemMessage"];
	setCurrentModelId: ChatState["setCurrentModelId"];
}

export function isCommand(line: string): boolean {
	return line.startsWith("/");
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
				const newId = (result.configOptions[0]?.currentValue as string | undefined) ?? modelId;
				ctx.setCurrentModelId(newId);
				ctx.addSystemMessage(`model switched to: ${newId}`);
			} catch (err) {
				ctx.addSystemMessage(`error: ${String(err)}`);
			}
			return true;
		}

		default:
			return false;
	}
}
