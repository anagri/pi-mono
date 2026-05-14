import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Message,
	type Model,
	registerFauxProvider,
	type ToolResultMessage,
	type Usage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	computeFileLists,
	extractFileOpsFromMessage,
	extractText,
	extractToolCalls,
	formatFileOperations,
	formatLocationHint,
	isToolResultMessage,
	joinTextBlocks,
	newFileOps,
	runSummarizationLLM,
	serializeConversation,
} from "./_shared.js";

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

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});

afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newFaux(): FauxProviderRegistration {
	const p = registerFauxProvider();
	providers.push(p);
	return p;
}

function modelOf(faux: FauxProviderRegistration): Model<Api> {
	return faux.getModel() as Model<Api>;
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantToolCall(name: string, args: Record<string, unknown>): AgentMessage {
	const msg: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `tc:${name}:${Math.random().toString(36).slice(2)}`,
				name,
				arguments: args,
			},
		],
		stopReason: "stop",
		api: "openai-completions",
		provider: "faux",
		model: "faux-model",
		usage: ZERO_USAGE,
		timestamp: 1,
	};
	return msg as AgentMessage;
}

test("extractFileOpsFromMessage records read/write/edit tool calls into the right Sets", () => {
	const ops = newFileOps();
	extractFileOpsFromMessage(assistantToolCall("read", { path: "/a.ts" }), ops);
	extractFileOpsFromMessage(assistantToolCall("write", { path: "/b.ts" }), ops);
	extractFileOpsFromMessage(assistantToolCall("edit", { path: "/c.ts" }), ops);
	expect([...ops.read]).toEqual(["/a.ts"]);
	expect([...ops.written]).toEqual(["/b.ts"]);
	expect([...ops.edited]).toEqual(["/c.ts"]);
});

test("extractFileOpsFromMessage ignores non-assistant roles", () => {
	const ops = newFileOps();
	const userMsg: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: "hi" }],
		timestamp: 1,
	} as AgentMessage;
	extractFileOpsFromMessage(userMsg, ops);
	expect(ops.read.size + ops.written.size + ops.edited.size).toBe(0);
});

test("extractFileOpsFromMessage skips tool calls without a string `path` argument", () => {
	const ops = newFileOps();
	extractFileOpsFromMessage(assistantToolCall("read", {}), ops);
	extractFileOpsFromMessage(assistantToolCall("write", { path: 123 }), ops);
	expect(ops.read.size + ops.written.size + ops.edited.size).toBe(0);
});

test("computeFileLists demotes a file present in both read and modified sets to modified-only", () => {
	const ops = newFileOps();
	ops.read.add("/shared.ts");
	ops.edited.add("/shared.ts");
	ops.read.add("/read-only.ts");
	ops.written.add("/written.ts");
	const result = computeFileLists(ops);
	expect(result.readFiles).toEqual(["/read-only.ts"]);
	expect(result.modifiedFiles).toEqual(["/shared.ts", "/written.ts"]);
});

test("computeFileLists returns sorted output", () => {
	const ops = newFileOps();
	ops.read.add("/z.ts");
	ops.read.add("/a.ts");
	ops.edited.add("/m.ts");
	ops.written.add("/b.ts");
	const result = computeFileLists(ops);
	expect(result.readFiles).toEqual(["/a.ts", "/z.ts"]);
	expect(result.modifiedFiles).toEqual(["/b.ts", "/m.ts"]);
});

test("formatFileOperations returns empty string when both lists are empty", () => {
	expect(formatFileOperations([], [])).toBe("");
});

test("formatFileOperations renders read-files section only when read list is populated", () => {
	const out = formatFileOperations(["/a.ts"], []);
	expect(out).toContain("<read-files>\n/a.ts\n</read-files>");
	expect(out).not.toContain("<modified-files>");
});

test("formatFileOperations renders both sections when both lists are populated", () => {
	const out = formatFileOperations(["/a.ts"], ["/b.ts"]);
	expect(out).toContain("<read-files>\n/a.ts\n</read-files>");
	expect(out).toContain("<modified-files>\n/b.ts\n</modified-files>");
});

test("joinTextBlocks filters non-text blocks and joins with the supplied separator", () => {
	const out = joinTextBlocks(
		[{ type: "text", text: "alpha" }, { type: "image" }, { type: "text", text: "beta" }],
		"|",
	);
	expect(out).toBe("alpha|beta");
});

test("joinTextBlocks defaults to empty-string separator", () => {
	const out = joinTextBlocks([
		{ type: "text", text: "ab" },
		{ type: "text", text: "cd" },
	]);
	expect(out).toBe("abcd");
});

test("serializeConversation includes thinking blocks for assistant messages", () => {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reasoning..." },
			{ type: "text", text: "answer" },
		],
		api: "openai-completions",
		provider: "faux",
		model: "faux-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 1,
	};
	const out = serializeConversation([assistant]);
	expect(out).toContain("[Assistant thinking]: reasoning...");
	expect(out).toContain("[Assistant]: answer");
});

test("serializeConversation truncates tool results past 2000 chars with a marker", () => {
	const longText = "x".repeat(2500);
	const messages: Message[] = [
		{
			role: "toolResult",
			toolCallId: "tc:1",
			toolName: "read",
			content: [{ type: "text", text: longText }],
			isError: false,
			timestamp: 1,
		},
	];
	const out = serializeConversation(messages);
	expect(out).toContain("[Tool result]:");
	expect(out).toContain("[... 500 more characters truncated]");
});

test("serializeConversation renders user, assistant, and toolResult roles", () => {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "faux",
		model: "faux-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 2,
	};
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		assistant,
		{
			role: "toolResult",
			toolCallId: "tc:1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 3,
		},
	];
	const out = serializeConversation(messages);
	expect(out).toContain("[User]: hello");
	expect(out).toContain("[Assistant]: hi");
	expect(out).toContain("[Tool result]: result");
});

test("runSummarizationLLM returns the joined text content from a successful response", async () => {
	const faux = newFaux();
	faux.setResponses([() => fauxAssistantMessage("the summary")]);
	const result = await runSummarizationLLM(modelOf(faux), "system", "user prompt", {
		apiKey: "k",
		maxTokens: 100,
		errorPrefix: "Summarization failed",
	});
	expect(result).toBe("the summary");
});

test("runSummarizationLLM throws with the supplied errorPrefix when the response stops with error", async () => {
	const faux = newFaux();
	faux.setResponses([() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
	await expect(
		runSummarizationLLM(modelOf(faux), "system", "user prompt", {
			apiKey: "k",
			maxTokens: 100,
			errorPrefix: "Summarization failed",
		}),
	).rejects.toThrow("Summarization failed: boom");
});

test("runSummarizationLLM uses 'unknown error' when errorMessage is absent", async () => {
	const faux = newFaux();
	faux.setResponses([() => fauxAssistantMessage("", { stopReason: "error" })]);
	await expect(
		runSummarizationLLM(modelOf(faux), "system", "user prompt", {
			apiKey: "k",
			maxTokens: 100,
			errorPrefix: "X",
		}),
	).rejects.toThrow("X: unknown error");
});

test("runSummarizationLLM forwards apiKey to the provider call", async () => {
	const faux = newFaux();
	let observedApiKey: string | undefined;
	faux.setResponses([
		(_ctx, options) => {
			observedApiKey = options?.apiKey;
			return fauxAssistantMessage("ok");
		},
	]);
	await runSummarizationLLM(modelOf(faux), "system", "user", {
		apiKey: "secret-key",
		maxTokens: 100,
		errorPrefix: "X",
	});
	expect(observedApiKey).toBe("secret-key");
});

describe("isToolResultMessage type guard", () => {
	test("returns false for non-toolResult messages", () => {
		expect(isToolResultMessage({ role: "user", content: "x", timestamp: 0 })).toBe(false);
	});

	test("returns true for toolResult messages", () => {
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
