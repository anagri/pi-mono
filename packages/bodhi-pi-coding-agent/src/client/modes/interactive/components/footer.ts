import { Text } from "@earendil-works/pi-tui";
import chalk from "chalk";

export class FooterComponent extends Text {
	private model = "";
	private sessionId = "";
	private status = "";

	constructor() {
		super("", 0, 0);
		this.refresh();
	}

	setModel(model: string): void {
		this.model = model;
		this.refresh();
	}

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
		this.refresh();
	}

	setStatus(status: string): void {
		this.status = status;
		this.refresh();
	}

	private refresh(): void {
		const parts: string[] = [];
		if (this.model) parts.push(chalk.cyan(this.model));
		if (this.sessionId) parts.push(chalk.dim(this.sessionId.slice(0, 8) + "…"));
		if (this.status) parts.push(chalk.yellow(this.status));
		this.setText(chalk.dim("─".repeat(2)) + " " + (parts.join(chalk.dim(" | ")) || chalk.dim("bodhi-pi")));
	}
}
