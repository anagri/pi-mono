import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { afterEach, beforeEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

beforeEach(async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
});

afterEach(async () => {
	await harness.cleanup();
});

test("/fork before a user message: new session excludes that turn (visible via /entries)", async () => {
	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with one short sentence: what comes after Tuesday?" }],
	});
	await harness.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with one short sentence: what comes after Wednesday?" }],
	});

	const entriesResp = await harness.client.listSessionEntries({ sessionId });
	const userEntries = entriesResp.entries.filter((e) => e.role === "user");
	expect(userEntries.length).toBe(2);
	const forkAt = userEntries[1];

	const fork = await harness.client.forkSession({
		sessionId,
		entryId: forkAt.id,
		position: "before",
	});
	expect(fork.selectedText?.toLowerCase()).toContain("wednesday");

	const forkedEntries = await harness.client.listSessionEntries({
		sessionId: fork.newSessionId,
	});
	expect(forkedEntries.entries.filter((e) => e.role === "user")).toHaveLength(1);
	expect(forkedEntries.entries.find((e) => e.id === forkAt.id)).toBeUndefined();
}, 60_000);

test("/clone duplicates the full chain at the leaf", async () => {
	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with one short sentence: what comes after Tuesday?" }],
	});

	const original = await harness.client.listSessionEntries({ sessionId });

	const clone = await harness.client.cloneSession({ sessionId });
	const cloned = await harness.client.listSessionEntries({
		sessionId: clone.newSessionId,
	});
	expect(cloned.entries.length).toBe(original.entries.length);
}, 60_000);
