import { Text } from "@earendil-works/pi-tui";
import chalk from "chalk";

interface ToolCallContent {
	type: string;
	content?: { type: string; text?: string };
}

function extractPreview(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return (content as ToolCallContent[])
		.filter((b) => b.type === "content" && b.content?.type === "text")
		.map((b) => b.content?.text ?? "")
		.join("")
		.slice(0, 200);
}

export class ToolCallComponent extends Text {
	private title: string;
	private status: "in_progress" | "completed" | "failed" = "in_progress";

	constructor(title: string) {
		super(chalk.cyan(`⚒ ${title}`), 2, 0);
		this.title = title;
	}

	setCompleted(content: unknown): void {
		this.status = "completed";
		const preview = extractPreview(content);
		const line = preview ? `✓ ${this.title}\n  ${chalk.dim("→")} ${chalk.dim(preview)}` : `✓ ${this.title}`;
		this.setText(chalk.green(line));
	}

	setFailed(content: unknown): void {
		this.status = "failed";
		const preview = extractPreview(content);
		const line = preview ? `✗ ${this.title}\n  ${chalk.dim("→")} ${preview}` : `✗ ${this.title}`;
		this.setText(chalk.red(line));
	}

	getStatus(): string {
		return this.status;
	}
}
