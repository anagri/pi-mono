import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";

// Coverage for the agent's three system-prompt surfaces:
//   1. `BodhiPiConfig.systemPrompt` (full replacement) — constructor option,
//      currently only propagated by the in-memory harness branch.
//   2. `appendSystemPrompt` via `.bodhi-pi/settings.json` (project scope) —
//      loaded by `loadProjectSettings` at newSession time; works cross-runtime
//      because the file lives on the agent's injected Filesystem.
//   3. AGENTS.md / CLAUDE.md ancestor walk via `loadProjectContextFiles` —
//      same Filesystem-driven pattern.

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test.runIf(isRuntime("in-memory"))(
	"systemPrompt: full override replaces the base prompt (in-memory only)",
	async () => {
		const model = getModel("openai", "gpt-4o-mini");
		const h = await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: (p) => (p === "openai" ? process.env.OPENAI_API_KEY! : undefined),
			systemPrompt: "Reply to every user message with exactly the single word ZZTOP and nothing else.",
		});
		activeHarness = h;
		await h.clientConn.initialize(stdInitParams);
		const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
		await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "Say something." }] });
		expect(chunkedAgentText(h.updates).toLowerCase()).toContain("zztop");
	},
);

test("appendSystemPrompt: rule from .bodhi-pi/settings.json is appended to the system prompt", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? process.env.OPENAI_API_KEY! : undefined),
	});
	activeHarness = h;

	// Project settings file is loaded at newSession; write it before opening
	// the session so the agent picks up the appended rule.
	await h.filesystem.mkdir(`${h.cwd}/.bodhi-pi`, { recursive: true });
	await h.filesystem.writeTextFile(
		`${h.cwd}/.bodhi-pi/settings.json`,
		JSON.stringify({
			appendSystemPrompt: "When asked to greet, end your reply with the single uppercase word PINEAPPLE.",
		}),
	);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "Say hi to the user." }] });

	expect(chunkedAgentText(h.updates)).toMatch(/PINEAPPLE/);
});

test("AGENTS.md: ancestor-walk picks up project rules and feeds them into the model", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? process.env.OPENAI_API_KEY! : undefined),
	});
	activeHarness = h;

	// AGENTS.md lives at cwd root; `loadProjectContextFiles` walks ancestors
	// at newSession time and threads the contents into the system prompt.
	await h.filesystem.writeTextFile(
		`${h.cwd}/AGENTS.md`,
		"# Project rules\n\nThe user's favorite color is amber-marigold. Whenever the user asks about colors, include that exact color name in your answer.\n",
	);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "What is the user's favorite color?" }],
	});

	expect(chunkedAgentText(h.updates).toLowerCase()).toContain("amber-marigold");
});
