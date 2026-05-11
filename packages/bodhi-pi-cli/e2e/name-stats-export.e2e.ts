import { EXT_SESSION_EXPORT, EXT_SESSION_SET_NAME, EXT_SESSION_STATS } from "@bodhiapp/bodhi-pi";
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

test("/name sets the display name; /session surfaces it; /export returns valid JSONL", async () => {
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply only with: hello" }],
	});

	await harness.clientConn.extMethod(EXT_SESSION_SET_NAME, { sessionId, name: "my-fork" });

	const stats = (await harness.clientConn.extMethod(EXT_SESSION_STATS, { sessionId })) as {
		messageCount: number;
		toolCallCount: number;
		leafId: string;
		name?: string;
	};
	expect(stats.name).toBe("my-fork");
	expect(stats.messageCount).toBeGreaterThanOrEqual(2);

	const exported = (await harness.clientConn.extMethod(EXT_SESSION_EXPORT, { sessionId })) as {
		format: string;
		content: string;
	};
	expect(exported.format).toBe("jsonl");
	const lines = exported.content.split("\n").filter((l) => l.length > 0);
	const header = JSON.parse(lines[0]);
	expect(header.type).toBe("session");
	expect(header.id).toBe(sessionId);
}, 60_000);
