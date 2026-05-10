import { EXT_SESSION_COMPACT } from "@bodhiapp/bodhi-pi";
import { createSqliteSessionStore } from "@bodhiapp/bodhi-pi-node";
import { getModel } from "@mariozechner/pi-ai";
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

test("/compact through Node host (real SQLite + gpt-4o-mini) writes compaction entry and survives reload", async () => {
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with one short sentence: what comes after Tuesday?" }],
	});
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with one short sentence: what comes after Wednesday?" }],
	});

	const result = (await harness.clientConn.extMethod(EXT_SESSION_COMPACT, { sessionId })) as {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
	};

	expect(typeof result.summary).toBe("string");
	expect(result.summary.length).toBeGreaterThan(20);

	// Re-open the SQLite store from the same dbPath to verify persistence.
	const store = createSqliteSessionStore({ dbPath: harness.dbPath });
	const record = await store.load(sessionId);
	expect(record).toBeDefined();
	const compactionEntries = record!.entries.filter((e) => e.type === "compaction");
	expect(compactionEntries).toHaveLength(1);
	const lastEntry = record!.entries[record!.entries.length - 1];
	expect(lastEntry.id).toBe(compactionEntries[0].id);
}, 60_000);
