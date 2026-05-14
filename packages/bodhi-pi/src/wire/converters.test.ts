import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { agentToolContentForAcp, mapStopReason, toolResultContentForAcp } from "./converters.js";

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

	test("image blocks are dropped (image input not supported)", () => {
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
