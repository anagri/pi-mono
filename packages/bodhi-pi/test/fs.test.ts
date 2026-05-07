import { type Api, type FauxProviderRegistration, type Model, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, createInMemorySessionStore } from "../src/index.js";
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
