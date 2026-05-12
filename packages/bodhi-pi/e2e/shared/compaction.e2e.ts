import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";
import { EXT_SESSION_COMPACT } from "@/acp/constants.js";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

// 60s override: 4 chained prompts + a compact extension call exceeds 30s on most runs.
test("real LLM /compact returns a summary and the post-compact prompt still recalls earlier facts", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? process.env.OPENAI_API_KEY! : undefined),
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Remember: my pet's name is Mango. What is my pet's name? Reply in one short sentence.",
			},
		],
	});
	await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply in one short sentence: what colour is the sky on a clear day?" }],
	});
	await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply in one short sentence: what comes after Tuesday?" }],
	});

	const result = (await h.clientConn.extMethod(EXT_SESSION_COMPACT, { sessionId })) as {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
	};
	expect(typeof result.summary).toBe("string");
	expect(result.summary.length).toBeGreaterThan(20);
	expect(typeof result.firstKeptEntryId).toBe("string");
	expect(typeof result.tokensBefore).toBe("number");

	h.updates.length = 0;
	const followUp = await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "What is my pet's name? Reply with the single word." }],
	});
	expect(followUp.stopReason).toBe("end_turn");
	expect(chunkedAgentText(h.updates).toLowerCase()).toContain("mango");
}, 60_000);
