import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { stdInitParams } from "../test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "../test/helpers/cli-harness.js";
import { chunkedAgentText } from "../test/helpers/notifications.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

beforeEach(async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
});

afterEach(async () => {
	await harness.cleanup();
});

test("CLI agent returns end_turn and streams chunks (gpt-4o-mini)", async () => {
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	const result = await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with exactly one word: hello" }],
	});

	expect(result.stopReason).toBe("end_turn");
	expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("hello");
});
