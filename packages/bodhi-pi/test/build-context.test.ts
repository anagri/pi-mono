import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

function zeroUsage(totalTokens = 0): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

import { buildSessionContext } from "@/sessions/build-context.js";
import type { CompactionEntry, MessageEntry, SessionEntry } from "@/sessions/entries.js";
import type { SessionRecord } from "@/sessions/session-store.js";

function makeUserMessage(id: string, parentId: string | null, text: string): MessageEntry {
	const msg: UserMessage = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
	return { type: "message", id, parentId, timestamp: 1, message: msg };
}

function makeAssistantMessage(id: string, parentId: string | null, text: string): MessageEntry {
	const msg: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		api: "openai-completions",
		usage: zeroUsage(20),
		provider: "faux",
		model: "test",
		timestamp: 1,
	};
	return { type: "message", id, parentId, timestamp: 1, message: msg };
}

function makeRecord(entries: SessionEntry[], leafId: string | null): SessionRecord {
	return {
		id: "s-1",
		cwd: "/tmp",
		createdAt: 0,
		updatedAt: 0,
		leafId,
		entries,
	};
}

test("buildSessionContext walks parentId chain from leaf to root", () => {
	const a = makeUserMessage("u1", null, "hello");
	const b = makeAssistantMessage("a1", "u1", "hi");
	const c = makeUserMessage("u2", "a1", "more");
	const d = makeAssistantMessage("a2", "u2", "ok");
	const ctx = buildSessionContext(makeRecord([a, b, c, d], "a2"));
	expect(ctx.messages.map((m) => (m.role === "user" ? "u" : "a"))).toEqual(["u", "a", "u", "a"]);
});

test("buildSessionContext follows the chain even when entries array contains an alternate branch", () => {
	const u1 = makeUserMessage("u1", null, "hello");
	const a1 = makeAssistantMessage("a1", "u1", "main reply");
	const branchUser = makeUserMessage("u-branch", "u1", "branch question");
	const branchAssistant = makeAssistantMessage("a-branch", "u-branch", "branch reply");
	const ctx = buildSessionContext(makeRecord([u1, a1, branchUser, branchAssistant], "a1"));
	const texts = ctx.messages.flatMap((m) =>
		"content" in m && Array.isArray(m.content)
			? m.content.flatMap((c: { type: string; text?: string }) => (c.type === "text" && c.text ? [c.text] : []))
			: [],
	);
	expect(texts).toContain("hello");
	expect(texts).toContain("main reply");
	expect(texts).not.toContain("branch question");
	expect(texts).not.toContain("branch reply");
});

test("compaction entry replaces pre-checkpoint history with a synthesized summary message", () => {
	const u1 = makeUserMessage("u1", null, "first");
	const a1 = makeAssistantMessage("a1", "u1", "first reply");
	const u2 = makeUserMessage("u2", "a1", "second");
	const a2 = makeAssistantMessage("a2", "u2", "second reply");
	const compaction: CompactionEntry = {
		type: "compaction",
		id: "c1",
		parentId: "a2",
		timestamp: 1,
		summary: "first two turns covered topic X",
		firstKeptEntryId: "u2",
		tokensBefore: 1234,
	};
	const u3 = makeUserMessage("u3", "c1", "third");
	const ctx = buildSessionContext(makeRecord([u1, a1, u2, a2, compaction, u3], "u3"));
	const texts = ctx.messages.flatMap((m) =>
		"content" in m && Array.isArray(m.content)
			? m.content.flatMap((c: { type: string; text?: string }) => (c.type === "text" && c.text ? [c.text] : []))
			: [],
	);
	expect(texts.some((t) => t.includes("<context-summary"))).toBe(true);
	expect(texts.some((t) => t.includes("first two turns covered topic X"))).toBe(true);
	expect(texts).toContain("second");
	expect(texts).toContain("second reply");
	expect(texts).toContain("third");
	expect(texts).not.toContain("first");
	expect(texts).not.toContain("first reply");
});

test("legacy entries without parentId fall back to array-order linearization", () => {
	const legacyA: MessageEntry = {
		type: "message",
		id: "u1",
		timestamp: 1,
		message: {
			role: "user",
			content: [{ type: "text", text: "legacy 1" }],
			timestamp: 1,
		} as UserMessage,
	};
	const legacyB: MessageEntry = {
		type: "message",
		id: "a1",
		timestamp: 2,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "legacy 2" }],
			stopReason: "stop",
			api: "openai-completions",
			usage: zeroUsage(),
			provider: "faux",
			model: "test",
			timestamp: 2,
		} as AssistantMessage,
	};
	const ctx = buildSessionContext(makeRecord([legacyA, legacyB], null));
	expect(ctx.messages).toHaveLength(2);
});

test("buildSessionContext returns latest model_change as currentModelId", () => {
	const u1 = makeUserMessage("u1", null, "hello");
	const mc: SessionEntry = {
		type: "model_change",
		id: "m1",
		parentId: "u1",
		timestamp: 1,
		provider: "openai",
		modelId: "gpt-4o-mini",
	};
	const a1 = makeAssistantMessage("a1", "m1", "hi");
	const ctx = buildSessionContext(makeRecord([u1, mc, a1], "a1"));
	expect(ctx.currentModelId).toBe("gpt-4o-mini");
});

test("buildSessionContext picks up latest session_info name on the active path", () => {
	const u1 = makeUserMessage("u1", null, "hello");
	const info: SessionEntry = {
		type: "session_info",
		id: "i1",
		parentId: "u1",
		timestamp: 1,
		name: "renamed",
	};
	const a1 = makeAssistantMessage("a1", "i1", "hi");
	const ctx = buildSessionContext(makeRecord([u1, info, a1], "a1"));
	expect(ctx.name).toBe("renamed");
});
