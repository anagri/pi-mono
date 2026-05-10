import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";
import {
	agentToolContentForAcp,
	extractText,
	extractToolCalls,
	formatLocationHint,
	isAssistantMessage,
	isToolResultMessage,
	mapStopReason,
	toolResultContentForAcp,
} from "./notifications.js";

const baseAssistant = {
	role: "assistant" as const,
	api: "test",
	provider: "test",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: Date.now(),
};

describe("isAssistantMessage / isToolResultMessage type guards", () => {
	test("isAssistantMessage discriminates on role", () => {
		expect(isAssistantMessage({ role: "user", content: "x", timestamp: 0 })).toBe(false);
		expect(isAssistantMessage({ ...baseAssistant, content: [] } as AssistantMessage)).toBe(true);
	});

	test("isToolResultMessage discriminates on role", () => {
		expect(isToolResultMessage({ role: "user", content: "x", timestamp: 0 })).toBe(false);
		expect(
			isToolResultMessage({
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [],
				isError: false,
				timestamp: 0,
			}),
		).toBe(true);
	});
});

describe("extractText", () => {
	test("user message with plain string content", () => {
		const msg: UserMessage = { role: "user", content: "hello", timestamp: 0 };
		expect(extractText(msg)).toBe("hello");
	});

	test("user message with array content joins text blocks only", () => {
		const msg: UserMessage = {
			role: "user",
			content: [
				{ type: "text", text: "hello " },
				{ type: "text", text: "world" },
			],
			timestamp: 0,
		};
		expect(extractText(msg)).toBe("hello world");
	});

	test("assistant message joins text blocks; ignores toolCall blocks", () => {
		const msg: AssistantMessage = {
			...baseAssistant,
			content: [
				{ type: "text", text: "Sure, " },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
				{ type: "text", text: "let me read it." },
			],
		};
		expect(extractText(msg)).toBe("Sure, let me read it.");
	});

	test("returns empty string for messages with no text", () => {
		const msg: AssistantMessage = {
			...baseAssistant,
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
		};
		expect(extractText(msg)).toBe("");
	});

	test("returns empty string for toolResult messages", () => {
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 0,
		};
		expect(extractText(msg)).toBe("");
	});
});

describe("extractToolCalls", () => {
	test("returns every toolCall block from an assistant message", () => {
		const msg: AssistantMessage = {
			...baseAssistant,
			content: [
				{ type: "text", text: "ok" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/x" } },
				{ type: "toolCall", id: "t2", name: "write", arguments: { path: "/y", content: "hi" } },
			],
		};
		const calls = extractToolCalls(msg);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ id: "t1", name: "read", arguments: { path: "/x" } });
		expect(calls[1]).toEqual({ id: "t2", name: "write", arguments: { path: "/y", content: "hi" } });
	});

	test("returns empty array for assistant messages without tool calls", () => {
		const msg: AssistantMessage = {
			...baseAssistant,
			content: [{ type: "text", text: "no tools here" }],
		};
		expect(extractToolCalls(msg)).toEqual([]);
	});

	test("returns empty array for non-assistant messages", () => {
		const msg: UserMessage = { role: "user", content: "ignored", timestamp: 0 };
		expect(extractToolCalls(msg)).toEqual([]);
	});
});

describe("agentToolContentForAcp / toolResultContentForAcp", () => {
	test("empty input returns empty array", () => {
		expect(agentToolContentForAcp([])).toEqual([]);
	});

	test("text-only blocks wrap into a single content block", () => {
		const out = agentToolContentForAcp([
			{ type: "text", text: "first " },
			{ type: "text", text: "second" },
		]);
		expect(out).toEqual([{ type: "content", content: { type: "text", text: "first second" } }]);
	});

	test("image blocks are dropped (image input not supported in M3.x)", () => {
		const out = agentToolContentForAcp([
			{ type: "text", text: "before" },
			{ type: "image", data: "...", mimeType: "image/png" },
			{ type: "text", text: " after" },
		]);
		expect(out).toEqual([{ type: "content", content: { type: "text", text: "before after" } }]);
	});

	test("empty-text-only input collapses to empty array", () => {
		expect(agentToolContentForAcp([{ type: "text", text: "" }])).toEqual([]);
	});

	test("toolResultContentForAcp delegates to agentToolContentForAcp", () => {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "t",
			toolName: "read",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: 0,
		};
		expect(toolResultContentForAcp(result)).toEqual([{ type: "content", content: { type: "text", text: "hello" } }]);
	});
});

describe("formatLocationHint", () => {
	test("returns path string when args has one", () => {
		expect(formatLocationHint({ path: "/x.txt" })).toBe("/x.txt");
	});

	test("returns empty string when args has no path", () => {
		expect(formatLocationHint({})).toBe("");
	});

	test("returns empty string for null / undefined", () => {
		expect(formatLocationHint(null)).toBe("");
		expect(formatLocationHint(undefined)).toBe("");
	});

	test("returns empty string when path is not a string", () => {
		expect(formatLocationHint({ path: 123 })).toBe("");
	});
});

describe("mapStopReason", () => {
	test("aborted maps to cancelled", () => {
		expect(mapStopReason("aborted")).toBe("cancelled");
	});

	test("length maps to max_tokens", () => {
		expect(mapStopReason("length")).toBe("max_tokens");
	});

	test("stop and toolUse map to end_turn", () => {
		expect(mapStopReason("stop")).toBe("end_turn");
		expect(mapStopReason("toolUse")).toBe("end_turn");
	});

	test("undefined falls back to end_turn", () => {
		expect(mapStopReason(undefined)).toBe("end_turn");
	});
});
