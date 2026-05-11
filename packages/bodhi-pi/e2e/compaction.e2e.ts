import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { requireEnv } from "@test/helpers/env.js";
import { createTestHarness } from "@test/helpers/harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { EXT_SESSION_COMPACT } from "@/acp/constants.js";

test("real LLM /compact returns a summary and the post-compact prompt still recalls earlier facts", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const { clientConn, updates } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Remember: my pet's name is Mango. What is my pet's name? Reply in one short sentence.",
			},
		],
	});
	await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply in one short sentence: what colour is the sky on a clear day?" }],
	});
	await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply in one short sentence: what comes after Tuesday?" }],
	});

	const result = (await clientConn.extMethod(EXT_SESSION_COMPACT, { sessionId })) as {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
	};
	expect(typeof result.summary).toBe("string");
	expect(result.summary.length).toBeGreaterThan(20);
	expect(typeof result.firstKeptEntryId).toBe("string");
	expect(typeof result.tokensBefore).toBe("number");

	updates.length = 0;
	const followUp = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "What is my pet's name? Reply with the single word." }],
	});
	expect(followUp.stopReason).toBe("end_turn");
	expect(chunkedAgentText(updates).toLowerCase()).toContain("mango");
}, 60_000);
