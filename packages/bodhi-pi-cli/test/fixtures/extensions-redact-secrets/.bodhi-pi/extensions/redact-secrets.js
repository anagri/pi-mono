export default function (pi) {
	pi.on("tool_result", (event) => {
		const newContent = event.result.content.map((b) =>
			b.type === "text" ? { ...b, text: b.text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]") } : b,
		);
		const changed = newContent.some((b, i) => b !== event.result.content[i]);
		return changed ? { content: newContent } : undefined;
	});
}
