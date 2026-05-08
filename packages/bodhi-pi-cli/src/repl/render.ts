import type { SessionNotification } from "@agentclientprotocol/sdk";
import chalk from "chalk";

interface ToolCallContent {
	type: string;
	content?: { type: string; text?: string };
}

function extractContentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return (content as ToolCallContent[])
		.filter((b) => b.type === "content" && b.content?.type === "text")
		.map((b) => b.content?.text ?? "")
		.join("");
}

export interface Renderer {
	onNotification(notif: SessionNotification): void;
	flush(): void;
}

export function createRenderer(): Renderer {
	let inText = false;

	function onNotification(notif: SessionNotification): void {
		const update = notif.update as Record<string, unknown>;
		const kind = update.sessionUpdate as string;

		if (kind === "agent_message_chunk") {
			const content = update.content as { type: string; text?: string };
			if (content?.type === "text" && content.text) {
				inText = true;
				process.stdout.write(content.text);
			}
		} else if (kind === "tool_call") {
			if (inText) {
				process.stdout.write("\n");
				inText = false;
			}
			if (update.status === "in_progress") {
				const title = (update.title as string) ?? "";
				process.stdout.write(chalk.cyan(`⚒ ${title}\n`));
			}
		} else if (kind === "tool_call_update") {
			const status = update.status as string;
			const preview = extractContentText(update.content).slice(0, 400);
			if (status === "completed") {
				const line = preview ? `  → ${preview}` : "";
				if (line) process.stdout.write(chalk.dim(line) + "\n");
			} else if (status === "failed") {
				const line = preview ? `  ✗ ${preview}` : "  ✗ failed";
				process.stdout.write(chalk.red(line) + "\n");
			}
		} else if (kind === "user_message_chunk") {
			// history replay: show dimmed user messages
			const content = update.content as { type: string; text?: string };
			if (content?.type === "text" && content.text) {
				process.stdout.write(chalk.dim(`you: ${content.text}\n`));
			}
		}
	}

	function flush(): void {
		if (inText) {
			process.stdout.write("\n");
			inText = false;
		}
	}

	return { onNotification, flush };
}
