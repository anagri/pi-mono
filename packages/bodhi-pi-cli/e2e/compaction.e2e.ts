import { EXT_SESSION_COMPACT } from "@bodhiapp/bodhi-pi";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, beforeEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

beforeEach(async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
});

afterEach(async () => {
	await harness.cleanup();
});

test("/compact through Node host (real SQLite + gpt-4o-mini) returns a summary; post-compact prompt still recalls earlier fact", async () => {
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Remember: my pet's name is Mango. Reply only with: noted" }],
	});
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
	expect(typeof result.firstKeptEntryId).toBe("string");

	harness.updates.length = 0;
	const followUp = await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "What is my pet's name? Reply with the single word." }],
	});
	expect(followUp.stopReason).toBe("end_turn");
	expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("mango");
}, 60_000);
