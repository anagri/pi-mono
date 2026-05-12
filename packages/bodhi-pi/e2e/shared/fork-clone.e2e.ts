import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { requireEnv } from "@test/helpers/env.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test("/fork before a user message: new session excludes that turn (visible via /entries)", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
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

	const entriesResp = await h.client.listSessionEntries({ sessionId });
	const userEntries = entriesResp.entries.filter((e) => e.role === "user");
	expect(userEntries.length).toBe(2);
	const forkAt = userEntries[1];

	const fork = await h.client.forkSession({
		sessionId,
		entryId: forkAt.id,
		position: "before",
	});
	expect(fork.selectedText?.toLowerCase()).toContain("wednesday");

	const forkedEntries = await h.client.listSessionEntries({
		sessionId: fork.newSessionId,
	});
	expect(forkedEntries.entries.filter((e) => e.role === "user")).toHaveLength(1);
	expect(forkedEntries.entries.find((e) => e.id === forkAt.id)).toBeUndefined();
}, 60_000);

test("/clone duplicates the full chain at the leaf", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
	});
	activeHarness = h;

	await h.client.initialize(stdInitParams);
	const { sessionId } = await h.client.newSession({ cwd: h.cwd, mcpServers: [] });

	await h.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with one short sentence: what comes after Tuesday?" }],
	});

	const original = await h.client.listSessionEntries({ sessionId });

	const clone = await h.client.cloneSession({ sessionId });
	const cloned = await h.client.listSessionEntries({
		sessionId: clone.newSessionId,
	});
	expect(cloned.entries.length).toBe(original.entries.length);
}, 60_000);
