import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { afterEach, expect, test, vi } from "vitest";
import { handleCommand, type ReplState } from "@/repl/commands.js";
import { createRenderer } from "@/repl/render.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

afterEach(async () => {
	await harness?.cleanup();
});

test("/resume restores the previously-selected model from the persisted model_change entry", async () => {
	const mini = getModel("openai", "gpt-4o-mini");
	const full = getModel("openai", "gpt-4o");
	harness = await createCliTestHarness({
		model: mini,
		apiKey: OPENAI_KEY,
		extraModels: [full],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId: firstId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	const state: ReplState = {
		sessionId: firstId,
		currentModelId: mini.id,
		defaultModelId: mini.id,
		models: [mini, full],
		availableCommands: [],
		closed: false,
	};
	const renderer = createRenderer();
	const ctx = {
		clientConn: harness.clientConn,
		state,
		sessionStore: {} as never,
		renderer,
		cwd: harness.tmpDir,
	};

	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	// Step 1: switch to gpt-4o on the first session — this appends a
	// model_change entry to the SQLite SessionStore.
	await handleCommand(`/model ${full.id}`, ctx);
	expect(state.currentModelId).toBe(full.id);

	// Step 2: /new resets the active session and the default model.
	await handleCommand("/new", ctx);
	const secondId = state.sessionId;
	expect(secondId).not.toBe(firstId);
	expect(state.currentModelId).toBe(mini.id);

	// Step 3: /resume <firstId> reads loadSession's configOptions[0].currentValue
	// (which the agent populates from the latest persisted model_change entry)
	// and writes it back into state.currentModelId — gpt-4o restored.
	await handleCommand(`/resume ${firstId}`, ctx);
	expect(state.sessionId).toBe(firstId);
	expect(state.currentModelId).toBe(full.id);

	writeSpy.mockRestore();
});
