import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createBodhiPiAgent, createInMemoryFilesystem, createInMemorySessionStore } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { scriptToolThenDone } from "./helpers/faux-script.js";
import { createTestHarness } from "./helpers/harness.js";
import { toolCallStarts, toolCallUpdates, toolUpdateText } from "./helpers/tool-call-asserts.js";

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});

afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newProvider(): FauxProviderRegistration {
	const p = registerFauxProvider();
	providers.push(p);
	return p;
}

function harnessFor(
	faux: FauxProviderRegistration,
	opts?: { filesystem?: ReturnType<typeof createInMemoryFilesystem> },
) {
	const model = faux.getModel() as Model<Api>;
	return createTestHarness({ models: [model], defaultModelId: model.id, filesystem: opts?.filesystem });
}

test("read returns file contents", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	await harness.filesystem.writeTextFile("/notes.txt", "the cake is a lie");
	scriptToolThenDone(faux, "read", { path: "/notes.txt" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read it" }] });

	const starts = toolCallStarts(harness.updates);
	const ends = toolCallUpdates(harness.updates);
	expect(starts).toHaveLength(1);
	expect(starts[0].kind).toBe("read");
	expect(starts[0].rawInput).toMatchObject({ path: "/notes.txt" });
	expect(ends).toHaveLength(1);
	expect(ends[0].status).toBe("completed");
	expect(toolUpdateText(ends[0])).toContain("the cake is a lie");
});

test("read of missing file fails gracefully", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	scriptToolThenDone(faux, "read", { path: "/missing.txt" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read it" }] });

	const ends = toolCallUpdates(harness.updates);
	expect(ends).toHaveLength(1);
	expect(ends[0].status).toBe("failed");
	expect(toolUpdateText(ends[0]).toUpperCase()).toContain("ENOENT");
});

test("write creates a new file", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	scriptToolThenDone(faux, "write", { path: "/out.txt", content: "hi" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write it" }] });

	expect(await harness.filesystem.exists("/out.txt")).toBe(true);
	expect(await harness.filesystem.readTextFile("/out.txt")).toBe("hi");
	const ends = toolCallUpdates(harness.updates);
	expect(ends[0].status).toBe("completed");
	expect(toolUpdateText(ends[0])).toMatch(/Wrote \d+ bytes/);
});

test("write creates parent directories", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	scriptToolThenDone(faux, "write", { path: "/sub/dir/out.txt", content: "deep" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write it" }] });

	expect(await harness.filesystem.readTextFile("/sub/dir/out.txt")).toBe("deep");
	expect(toolCallUpdates(harness.updates)[0].status).toBe("completed");
});

test("edit replaces unique substring", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	await harness.filesystem.writeTextFile("/code.txt", "foo bar baz");
	scriptToolThenDone(faux, "edit", {
		path: "/code.txt",
		edits: [{ oldText: "bar", newText: "BAR" }],
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "edit it" }] });

	expect(await harness.filesystem.readTextFile("/code.txt")).toBe("foo BAR baz");
	expect(toolCallUpdates(harness.updates)[0].status).toBe("completed");
});

test("edit fails when oldText is not unique", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	await harness.filesystem.writeTextFile("/dup.txt", "x x");
	scriptToolThenDone(faux, "edit", {
		path: "/dup.txt",
		edits: [{ oldText: "x", newText: "Y" }],
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "edit it" }] });

	const ends = toolCallUpdates(harness.updates);
	expect(ends[0].status).toBe("failed");
	expect(toolUpdateText(ends[0]).toLowerCase()).toContain("not unique");
	expect(await harness.filesystem.readTextFile("/dup.txt")).toBe("x x");
});

test("ls lists directory entries", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	await harness.filesystem.writeTextFile("/a.txt", "a");
	await harness.filesystem.writeTextFile("/b.txt", "bb");
	await harness.filesystem.mkdir("/sub");
	scriptToolThenDone(faux, "ls", { path: "/" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ls" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	expect(text).toContain("a.txt\tfile\t1");
	expect(text).toContain("b.txt\tfile\t2");
	expect(text).toContain("sub\tdir");
});

test("find returns matching files", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	await harness.filesystem.mkdir("/src", { recursive: true });
	for (const name of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
		await harness.filesystem.writeTextFile(`/src/${name}`, "// ts");
	}
	for (const name of ["readme.md", "todo.md", "notes.md"]) {
		await harness.filesystem.writeTextFile(`/src/${name}`, "# md");
	}
	scriptToolThenDone(faux, "find", { pattern: "**/*.ts", path: "/" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "find ts files" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	const lines = text.split("\n").filter((l) => l.endsWith(".ts"));
	expect(lines).toHaveLength(5);
});

test("find respects limit", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	for (let i = 0; i < 50; i++) {
		await harness.filesystem.writeTextFile(`/f${i}.ts`, "x");
	}
	scriptToolThenDone(faux, "find", { pattern: "**/*.ts", path: "/", limit: 10 });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "find" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	const lines = text.split("\n").filter((l) => l.endsWith(".ts"));
	expect(lines).toHaveLength(10);
	expect(text).toMatch(/Truncated:.*10-matches limit/);
});

test("grep finds matches with file:line format", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	await harness.filesystem.writeTextFile("/a.txt", "first line\nneedle here\nthird line");
	await harness.filesystem.writeTextFile("/b.txt", "no match");
	await harness.filesystem.writeTextFile("/c.txt", "needle on first line\nlater");
	scriptToolThenDone(faux, "grep", { pattern: "needle", path: "/" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "grep" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	expect(text).toContain("/a.txt:2:needle here");
	expect(text).toContain("/c.txt:1:needle on first line");
	expect(text).not.toContain("/b.txt");
});

test("grep with glob filter only matches included files", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	await harness.filesystem.writeTextFile("/keep.ts", "needle");
	await harness.filesystem.writeTextFile("/skip.md", "needle");
	scriptToolThenDone(faux, "grep", {
		pattern: "needle",
		path: "/",
		glob: "**/*.ts",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "grep" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	expect(text).toContain("/keep.ts:1:needle");
	expect(text).not.toContain("/skip.md");
});

test("grep skips binary files", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	await harness.filesystem.writeTextFile("/text.txt", "needle in the haystack");
	// NUL byte built explicitly so the binary-skip path is visible to readers.
	await harness.filesystem.writeTextFile("/bin.dat", `binary${String.fromCharCode(0)}content needle`);
	scriptToolThenDone(faux, "grep", { pattern: "needle", path: "/" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "grep" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	expect(text).toContain("/text.txt:1:needle");
	expect(text).not.toContain("/bin.dat");
});

test("tool calls replay on session/load", async () => {
	const fauxA = newProvider();
	const filesystem = createInMemoryFilesystem();
	const sessionStore = createInMemorySessionStore();
	const modelA = fauxA.getModel() as Model<Api>;
	const writer = createTestHarness({
		models: [modelA],
		defaultModelId: modelA.id,
		filesystem,
		sessionStore,
	});
	scriptToolThenDone(fauxA, "write", { path: "/replay.txt", content: "captured" });

	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await writer.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write" }] });

	// Fresh client backed by the same store + filesystem.
	const fauxB = newProvider();
	const modelB = fauxB.getModel() as Model<Api>;
	const reader = createTestHarness({
		models: [modelB],
		defaultModelId: modelB.id,
		filesystem,
		sessionStore,
	});
	await reader.clientConn.initialize(stdInitParams);
	await reader.clientConn.loadSession({ sessionId, cwd: "/", mcpServers: [] });

	const replayedStarts = toolCallStarts(reader.updates);
	expect(replayedStarts).toHaveLength(1);
	expect(replayedStarts[0].status).toBe("completed");
	expect(replayedStarts[0].rawInput).toMatchObject({ path: "/replay.txt", content: "captured" });

	const replayedEnds = toolCallUpdates(reader.updates);
	expect(replayedEnds).toHaveLength(1);
	expect(replayedEnds[0].status).toBe("completed");
	expect(toolUpdateText(replayedEnds[0])).toMatch(/Wrote \d+ bytes/);
});

test("read with offset returns lines from that point", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
	await harness.filesystem.writeTextFile("/big.txt", lines.join("\n"));
	scriptToolThenDone(faux, "read", { path: "/big.txt", offset: 5 });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	expect(text).toContain("line-5");
	expect(text).toContain("line-20");
	expect(text).not.toContain("line-4\n");
});

test("read with limit returns N lines plus a continuation marker", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
	await harness.filesystem.writeTextFile("/big.txt", lines.join("\n"));
	scriptToolThenDone(faux, "read", { path: "/big.txt", offset: 1, limit: 3 });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	expect(text).toContain("line-1");
	expect(text).toContain("line-3");
	expect(text).not.toContain("line-4");
	expect(text).toMatch(/17 more lines.*offset=4/);
});

test("read byte-truncation kicks in for a very long single line", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	const longLine = "x".repeat(60_000);
	await harness.filesystem.writeTextFile("/long.txt", longLine);
	scriptToolThenDone(faux, "read", { path: "/long.txt" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	expect(text).toMatch(/Truncated by .*KB limit/);
});

test("grep byte-truncation kicks in when many matches accumulate", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	// Each match line will be ~30 bytes ("/f<i>.txt:1:" + a long string). Need >50KB total to trip the byte cap.
	const matchPayload = "needle".repeat(100); // 600 chars per line
	for (let i = 0; i < 200; i++) {
		await harness.filesystem.writeTextFile(`/f${i}.txt`, matchPayload);
	}
	scriptToolThenDone(faux, "grep", { pattern: "needle", path: "/" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "grep" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	expect(text).toMatch(/Truncated:.*KB output limit/);
});

test("grep truncates a long matched line at GREP_MAX_LINE_LENGTH with ellipsis", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	// 1000-char line containing 'needle'.
	const longLine = `${"x".repeat(900)}needle${"y".repeat(100)}`;
	await harness.filesystem.writeTextFile("/long.txt", longLine);
	scriptToolThenDone(faux, "grep", { pattern: "needle", path: "/" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "grep" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	const matchLine = text.split("\n").find((l) => l.startsWith("/long.txt:")) ?? "";
	expect(matchLine.endsWith("...")).toBe(true);
});

test("ls byte-truncation kicks in for a directory with many entries", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	// Each entry line is ~25 bytes ("file-NNNN.txt\tfile\t1\n"). Need >50KB total ⇒ ~2000 entries.
	for (let i = 0; i < 2500; i++) {
		await harness.filesystem.writeTextFile(`/file-${String(i).padStart(4, "0")}.txt`, "x");
	}
	scriptToolThenDone(faux, "ls", { path: "/" });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ls" }] });

	const text = toolUpdateText(toolCallUpdates(harness.updates)[0]);
	expect(text).toMatch(/Truncated:.*(KB output limit|entries limit)/);
});

test("multiple tool calls in one prompt all surface as notifications in order", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	// Prime two tool calls in sequence — pi-agent-core executes them sequentially
	// and re-prompts the LLM after each round of results. We script that loop:
	// turn 1: write,  turn 2 (after toolResult): read,  turn 3: "done".
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/m.txt", content: "hi" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read", { path: "/m.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "do both" }] });

	const starts = toolCallStarts(harness.updates);
	const ends = toolCallUpdates(harness.updates);
	expect(starts).toHaveLength(2);
	expect(starts[0].rawInput).toMatchObject({ path: "/m.txt", content: "hi" });
	expect(starts[1].rawInput).toMatchObject({ path: "/m.txt" });
	expect(ends).toHaveLength(2);
	expect(ends[0].status).toBe("completed");
	expect(ends[1].status).toBe("completed");
	expect(toolUpdateText(ends[1])).toContain("hi");
});

test("tool failure replays as failed on session/load", async () => {
	const fauxA = newProvider();
	const filesystem = createInMemoryFilesystem();
	const sessionStore = createInMemorySessionStore();
	const modelA = fauxA.getModel() as Model<Api>;
	const writer = createTestHarness({
		models: [modelA],
		defaultModelId: modelA.id,
		filesystem,
		sessionStore,
	});
	// First turn: read a missing file (will fail); second turn: model says "ok".
	scriptToolThenDone(fauxA, "read", { path: "/missing.txt" });

	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await writer.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read" }] });

	// Reader replays the failed tool call.
	const fauxB = newProvider();
	const modelB = fauxB.getModel() as Model<Api>;
	const reader = createTestHarness({
		models: [modelB],
		defaultModelId: modelB.id,
		filesystem,
		sessionStore,
	});
	await reader.clientConn.initialize(stdInitParams);
	await reader.clientConn.loadSession({ sessionId, cwd: "/", mcpServers: [] });

	const replayedEnds = toolCallUpdates(reader.updates);
	expect(replayedEnds).toHaveLength(1);
	expect(replayedEnds[0].status).toBe("failed");
	expect(toolUpdateText(replayedEnds[0]).toUpperCase()).toContain("ENOENT");
});

test("prompt rejects with -32602 when session is unknown", async () => {
	const faux = newProvider();
	const harness = harnessFor(faux);
	faux.setResponses([fauxAssistantMessage("ok")]);

	await harness.clientConn.initialize(stdInitParams);
	await expect(
		harness.clientConn.prompt({ sessionId: "no-such-session", prompt: [{ type: "text", text: "x" }] }),
	).rejects.toThrow(/not loaded/);
});

test("createBodhiPiAgent throws synchronously when defaultModelId is not in models", () => {
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	expect(() =>
		createBodhiPiAgent({
			models: [model],
			defaultModelId: "nonexistent",
			getApiKey: () => "test-key",
			sessionStore: createInMemorySessionStore(),
			filesystem: createInMemoryFilesystem(),
		}),
	).toThrow(/defaultModelId.*nonexistent/);
});
