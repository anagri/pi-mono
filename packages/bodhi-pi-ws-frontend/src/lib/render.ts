interface ToolCallContent {
	type: string;
	content?: { type: string; text?: string };
}

export function extractContentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return (content as ToolCallContent[])
		.filter((b) => b.type === "content" && b.content?.type === "text")
		.map((b) => b.content?.text ?? "")
		.join("");
}
