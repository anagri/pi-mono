import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

// Flow test: same session, same prompts, exercise both /fork and /clone semantics.
// /fork at the second user message excludes that turn; /clone at the leaf duplicates the whole chain.
test("session graph: /fork excludes target turn; /clone duplicates the chain", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);

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
