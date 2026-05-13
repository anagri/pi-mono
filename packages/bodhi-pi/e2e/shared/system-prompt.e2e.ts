import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

// Cross-runtime coverage for the two Filesystem-driven system-prompt surfaces:
//   * `appendSystemPrompt` via `.bodhi-pi/settings.json` (project scope)
//   * AGENTS.md / CLAUDE.md ancestor walk via `loadProjectContextFiles`
// Both work cross-runtime because the source files live on the agent's injected
// Filesystem. Full-replacement `BodhiPiConfig.systemPrompt` is a constructor
// option with no transport-reachable hook, so it's covered in
// `test/system-prompt-append.test.ts` via the faux provider instead.

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test("appendSystemPrompt: rule from .bodhi-pi/settings.json is appended to the system prompt", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? process.env.OPENAI_API_KEY! : undefined),
	});
	activeHarness = h;

	// Project settings file is loaded at newSession; seed it before initialize
	// so the agent picks up the appended rule.
	await h.setupFiles({
		".bodhi-pi/settings.json": JSON.stringify({
			appendSystemPrompt: "When asked to greet, end your reply with the single uppercase word PINEAPPLE.",
		}),
	});

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
	await h.setupFiles({
		"AGENTS.md":
			"# Project rules\n\nThe user's favorite color is amber-marigold. Whenever the user asks about colors, include that exact color name in your answer.\n",
	});

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "What is the user's favorite color?" }],
	});

	expect(chunkedAgentText(h.updates).toLowerCase()).toContain("amber-marigold");
});
