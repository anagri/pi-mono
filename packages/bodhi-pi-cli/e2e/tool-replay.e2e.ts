import fsNode from "node:fs/promises";
import path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { toolCallStarts, toolCallUpdates } from "@test/helpers/tool-call-asserts.js";
import { afterEach, expect, test, vi } from "vitest";
import { handleCommand, type ReplState } from "@/repl/commands.js";
import { createRenderer } from "@/repl/render.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

afterEach(async () => {
	await harness?.cleanup();
});

test("a write tool_call replays as a completed card after /resume — Node host parity with web tool-replay", async () => {
	const mini = getModel("openai", "gpt-4o-mini");
	harness = await createCliTestHarness({ model: mini, apiKey: OPENAI_KEY });

	await harness.client.initialize(stdInitParams);
	const { sessionId: sessionA } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	// Drive a turn that calls write — agent persists the tool_call entry into SQLite.
	const target = path.join(harness.tmpDir, "note.txt");
	await harness.client.prompt({
		sessionId: sessionA,
		prompt: [
			{
				type: "text",
				text: `Use the write tool to create ${target} with content 'persisted'. After the write, reply with exactly: ok`,
			},
		],
	});
	const writeStarts = toolCallStarts(harness.updates).filter(
		(t) => (t.rawInput as { path?: string })?.path === target,
	);
	expect(writeStarts.length, "expected the write tool to fire during session A").toBeGreaterThanOrEqual(1);
	expect(await fsNode.readFile(target, "utf8")).toContain("persisted");

	// /new clears the active session — start a fresh one through the REPL slash dispatcher.
	const state: ReplState = {
		sessionId: sessionA,
		currentModelId: mini.id,
		defaultModelId: mini.id,
		models: [mini],
		availableCommands: [],
		closed: false,
	};
	const renderer = createRenderer();
	const ctx = {
		client: harness.client,
		state,
		sessionStore: harness as never, // unused by /new and /resume
		renderer,
		cwd: harness.tmpDir,
	};
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	await handleCommand("/new", ctx);
	expect(state.sessionId).not.toBe(sessionA);

	// Snapshot updates from this point — we want to count tool calls that come
	// *only* from the loadSession history replay.
	const before = harness.updates.length;
	await handleCommand(`/resume ${sessionA}`, ctx);

	const replayed: SessionNotification[] = harness.updates.slice(before);
	const replayedStarts = toolCallStarts(replayed).filter((t) => (t.rawInput as { path?: string })?.path === target);
	expect(replayedStarts.length, "expected the write tool_call to replay during /resume").toBe(1);
	const replayedFinish = toolCallUpdates(replayed).filter((u) => u.status === "completed");
	expect(replayedFinish.length, "expected the replayed tool to land as completed").toBeGreaterThanOrEqual(1);

	writeSpy.mockRestore();
});
