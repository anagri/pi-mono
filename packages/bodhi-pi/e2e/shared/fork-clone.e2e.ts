import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

// Flow test: same session, same prompts, exercise both /fork and /clone semantics.
// /fork at the second user message excludes that turn; /clone at the leaf duplicates the whole chain.
test("session graph: /fork excludes target turn; /clone duplicates the chain", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? process.env.OPENAI_API_KEY! : undefined),
	});
	activeHarness = h;

	await h.client.initialize(stdInitParams);
	const { sessionId } = await h.client.newSession({ cwd: h.cwd, mcpServers: [] });

	await h.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with one short sentence: what comes after Tuesday?" }],
	});
	await h.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with one short sentence: what comes after Wednesday?" }],
	});

	const original = await h.client.listSessionEntries({ sessionId });
	const userEntries = original.entries.filter((e) => e.role === "user");
	expect(userEntries.length).toBe(2);
	const forkAt = userEntries[1];

	const fork = await h.client.forkSession({ sessionId, entryId: forkAt.id, position: "before" });
	expect.soft(fork.selectedText?.toLowerCase()).toContain("wednesday");

	const forkedEntries = await h.client.listSessionEntries({ sessionId: fork.newSessionId });
	expect.soft(forkedEntries.entries.filter((e) => e.role === "user")).toHaveLength(1);
	expect.soft(forkedEntries.entries.find((e) => e.id === forkAt.id)).toBeUndefined();

	const clone = await h.client.cloneSession({ sessionId });
	const cloned = await h.client.listSessionEntries({ sessionId: clone.newSessionId });
	expect.soft(cloned.entries.length).toBe(original.entries.length);
});
