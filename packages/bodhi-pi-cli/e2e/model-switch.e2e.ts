import { getModel } from "@mariozechner/pi-ai";
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

async function setup() {
	const mini = getModel("openai", "gpt-4o-mini");
	const full = getModel("openai", "gpt-4o");
	harness = await createCliTestHarness({
		model: mini,
		apiKey: OPENAI_KEY,
		extraModels: [full],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });
	const state: ReplState = {
		sessionId,
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
		// Cast: e2e doesn't use sessionStore through commands.ts, so leaving it
		// as unknown is safe for this slice.
		sessionStore: {} as never,
		renderer,
		cwd: harness.tmpDir,
	};
	return { ctx, state, mini, full };
}

test("/model with no args lists every registered model with the active one marked", async () => {
	const { ctx, mini } = await setup();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/model", ctx);

	const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(out).toContain(mini.id);
	expect(out).toContain("gpt-4o");
	// Active model is marked with a leading "*"
	expect(out).toMatch(new RegExp(`\\*\\s+${mini.id}`));

	writeSpy.mockRestore();
});

test("/model <id> switches the session model and updates state.currentModelId", async () => {
	const { ctx, state, full } = await setup();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand(`/model ${full.id}`, ctx);

	const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(out).toContain(`model switched to: ${full.id}`);
	expect(state.currentModelId).toBe(full.id);

	writeSpy.mockRestore();
});

test("/model <unknown> reports an error and leaves state.currentModelId unchanged", async () => {
	const { ctx, state, mini } = await setup();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/model not-a-real-model-id", ctx);

	const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(out.toLowerCase()).toMatch(/error/);
	expect(state.currentModelId).toBe(mini.id);

	writeSpy.mockRestore();
});
