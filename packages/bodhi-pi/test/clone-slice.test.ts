import { describe, expect, test } from "vitest";
import { cloneTranscriptSlice } from "@/sessions/clone-slice.js";
import type { SessionEntry } from "@/sessions/session-store.js";

function userMessageEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: 0,
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: 0,
		},
	};
}

function mcpInclusionEntry(id: string, parentId: string | null, slugs: string[]): SessionEntry {
	return {
		type: "mcp_inclusion_set",
		id,
		parentId,
		timestamp: 0,
		slugs,
	};
}

function extensionEntry(id: string, parentId: string | null, name: string): SessionEntry {
	return {
		type: "extension",
		id,
		parentId,
		timestamp: 0,
		extensionName: name,
		customType: "marker",
		data: {},
	};
}

function subagentLinkEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "subagent_link",
		id,
		parentId,
		timestamp: 0,
		parentSessionId: "parent-session",
		profileName: "p",
		task: "t",
		toolCallId: "tc",
		depth: 1,
		contextMode: "fresh",
	};
}

describe("cloneTranscriptSlice", () => {
	test("walks from explicit leaf to root in chronological order", () => {
		const e1 = userMessageEntry("e1", null, "first");
		const e2 = userMessageEntry("e2", "e1", "second");
		const e3 = userMessageEntry("e3", "e2", "third");
		const entries: SessionEntry[] = [e1, e2, e3];

		const result = cloneTranscriptSlice(entries, { leafOrFromEntryId: "e3" });
		expect(result.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
	});

	test("walks from an arbitrary middle entry, stopping at that entry", () => {
		const e1 = userMessageEntry("e1", null, "first");
		const e2 = userMessageEntry("e2", "e1", "second");
		const e3 = userMessageEntry("e3", "e2", "third");
		const entries: SessionEntry[] = [e1, e2, e3];

		const result = cloneTranscriptSlice(entries, { leafOrFromEntryId: "e2" });
		expect(result.map((e) => e.id)).toEqual(["e1", "e2"]);
	});

	test("excludeTargetEntry: true drops the target entry from the slice", () => {
		const e1 = userMessageEntry("e1", null, "first");
		const e2 = userMessageEntry("e2", "e1", "second");
		const e3 = userMessageEntry("e3", "e2", "third");
		const entries: SessionEntry[] = [e1, e2, e3];

		const result = cloneTranscriptSlice(entries, {
			leafOrFromEntryId: "e3",
			excludeTargetEntry: true,
		});
		expect(result.map((e) => e.id)).toEqual(["e1", "e2"]);
	});

	test("excludeEntryTypes filters those entry types out of the slice", () => {
		const e1 = userMessageEntry("e1", null, "first");
		const e2 = mcpInclusionEntry("e2", "e1", ["foo"]);
		const e3 = userMessageEntry("e3", "e2", "third");
		const e4 = extensionEntry("e4", "e3", "ext-name");
		const e5 = subagentLinkEntry("e5", "e4");
		const entries: SessionEntry[] = [e1, e2, e3, e4, e5];

		const result = cloneTranscriptSlice(entries, {
			leafOrFromEntryId: "e5",
			excludeEntryTypes: new Set(["mcp_inclusion_set", "extension", "subagent_link"]),
		});
		expect(result.map((e) => e.id)).toEqual(["e1", "e3"]);
	});

	test("empty entries returns []", () => {
		const result = cloneTranscriptSlice([], { leafOrFromEntryId: null });
		expect(result).toEqual([]);
	});

	test("missing leafOrFromEntryId falls back to the last array entry", () => {
		const e1 = userMessageEntry("e1", null, "first");
		const e2 = userMessageEntry("e2", "e1", "second");
		const e3 = userMessageEntry("e3", "e2", "third");
		const entries: SessionEntry[] = [e1, e2, e3];

		const result = cloneTranscriptSlice(entries, {});
		expect(result.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
	});

	test("excludeTargetEntry + excludeEntryTypes compose (target drop then filter)", () => {
		const e1 = userMessageEntry("e1", null, "first");
		const e2 = mcpInclusionEntry("e2", "e1", ["foo"]);
		const e3 = userMessageEntry("e3", "e2", "third");
		const entries: SessionEntry[] = [e1, e2, e3];

		const result = cloneTranscriptSlice(entries, {
			leafOrFromEntryId: "e3",
			excludeTargetEntry: true,
			excludeEntryTypes: new Set(["mcp_inclusion_set"]),
		});
		expect(result.map((e) => e.id)).toEqual(["e1"]);
	});
});
