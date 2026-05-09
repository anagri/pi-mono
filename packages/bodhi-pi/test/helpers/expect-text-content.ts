import { expect } from "vitest";

/**
 * Narrow a tool-result `content` array to its first text block and return the
 * text. Replaces the brittle `result.content[0] as { text: string }` pattern
 * — if the tool ever returns no content (legitimate edge case for empty
 * stdout/stderr), the cast hides a `TypeError` behind a misleading assertion.
 */
export function expectTextContent(result: { content?: ReadonlyArray<unknown> }): string {
	expect(result.content, "tool-result.content should be a non-empty array").toBeDefined();
	expect(result.content?.length ?? 0, "tool-result.content should have at least one block").toBeGreaterThanOrEqual(1);
	const first = result.content?.[0] as { type?: unknown; text?: unknown } | undefined;
	expect(first?.type, "first content block should be type 'text'").toBe("text");
	expect(typeof first?.text, "text block should have a string text field").toBe("string");
	return first?.text as string;
}
