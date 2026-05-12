import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Message,
	type Model,
	registerFauxProvider,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	computeFileLists,
	extractFileOpsFromMessage,
	formatFileOperations,
	joinTextBlocks,
	newFileOps,
	runSummarizationLLM,
	serializeConversation,
} from "./_shared.js";

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
