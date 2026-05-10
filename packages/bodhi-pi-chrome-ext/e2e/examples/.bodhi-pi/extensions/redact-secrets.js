/**
 * redact-secrets — scrubs anything matching the `sk-...` API-key shape out
 * of tool results before the agent (or you, in the tool-call card) sees it.
 *
 * Demonstrates the `tool_result` event with content mutation.
 *
 * Try in the chat (paired with the seeded secrets.txt):
 *   read secrets.txt and tell me what's there verbatim
 *
 * The tool-call card will show `[REDACTED]` where the original key was;
 * the agent's reply also won't contain the original token.
 */
export default function (pi) {
	pi.on("tool_result", (event) => {
		const newContent = event.result.content.map((b) =>
			b.type === "text"
				? { ...b, text: b.text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]") }
				: b,
		);
		const changed = newContent.some((b, i) => b !== event.result.content[i]);
		return changed ? { content: newContent } : undefined;
	});
}
