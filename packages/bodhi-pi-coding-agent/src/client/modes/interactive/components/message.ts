import { Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import chalk from "chalk";

const MARKDOWN_THEME: MarkdownTheme = {
	heading: (t) => chalk.bold(t),
	link: (t) => chalk.underline(t),
	linkUrl: (t) => chalk.dim(t),
	code: (t) => chalk.yellow(t),
	codeBlock: (t) => t,
	codeBlockBorder: (t) => chalk.dim(t),
	quote: (t) => chalk.italic(t),
	quoteBorder: (t) => chalk.dim(t),
	hr: (t) => chalk.dim(t),
	listBullet: (t) => chalk.dim(t),
	bold: (t) => chalk.bold(t),
	italic: (t) => chalk.italic(t),
	strikethrough: (t) => chalk.strikethrough(t),
	underline: (t) => chalk.underline(t),
};

export class UserMessageComponent extends Text {
	constructor(text: string) {
		super(chalk.bold.green("you") + chalk.dim(": ") + text, 1, 0);
	}
}

export class AssistantMessageComponent extends Markdown {
	private accumulated = "";

	constructor() {
		super("", 1, 0, MARKDOWN_THEME);
	}

	appendChunk(chunk: string): void {
		this.accumulated += chunk;
		this.setText(this.accumulated);
	}

	getAccumulated(): string {
		return this.accumulated;
	}
}

export class SystemMessageComponent extends Text {
	constructor(text: string) {
		super(chalk.dim(text), 1, 0);
	}
}
