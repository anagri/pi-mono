import { EXT_SESSION_CLONE, EXT_SESSION_ENTRIES, EXT_SESSION_FORK } from "@bodhiapp/bodhi-pi";
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

	const entriesResp = (await harness.clientConn.extMethod(EXT_SESSION_ENTRIES, { sessionId })) as {
		entries: { id: string; role: string; preview: string }[];
	};
	const userEntries = entriesResp.entries.filter((e) => e.role === "user");
	expect(userEntries.length).toBe(2);
	const forkAt = userEntries[1];

	const fork = (await harness.clientConn.extMethod(EXT_SESSION_FORK, {
		sessionId,
		entryId: forkAt.id,
		position: "before",
	})) as { newSessionId: string; selectedText?: string };
	expect(fork.selectedText?.toLowerCase()).toContain("wednesday");

	const forkedEntries = (await harness.clientConn.extMethod(EXT_SESSION_ENTRIES, {
		sessionId: fork.newSessionId,
	})) as { entries: { id: string; role: string }[] };
	expect(forkedEntries.entries.filter((e) => e.role === "user")).toHaveLength(1);
	expect(forkedEntries.entries.find((e) => e.id === forkAt.id)).toBeUndefined();
}, 60_000);

test("/clone duplicates the full chain at the leaf", async () => {
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with one short sentence: what comes after Tuesday?" }],
	});

	const original = (await harness.clientConn.extMethod(EXT_SESSION_ENTRIES, { sessionId })) as {
		entries: { id: string }[];
	};

	const clone = (await harness.clientConn.extMethod(EXT_SESSION_CLONE, { sessionId })) as { newSessionId: string };
	const cloned = (await harness.clientConn.extMethod(EXT_SESSION_ENTRIES, {
		sessionId: clone.newSessionId,
	})) as { entries: { id: string }[] };
	expect(cloned.entries.length).toBe(original.entries.length);
}, 60_000);
