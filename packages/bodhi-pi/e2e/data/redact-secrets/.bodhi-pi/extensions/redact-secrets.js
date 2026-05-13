export default (pi) => {
	pi.on("tool_result", (event) => {
		const newContent = event.result.content.map((block) => {
			if (block.type !== "text") return block;
			const cleaned = block.text.replace(/sk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]");
			return cleaned === block.text ? block : { ...block, text: cleaned };
		});
		const changed = newContent.some((b, i) => b !== event.result.content[i]);
		return changed ? { content: newContent } : undefined;
	});
};
