import type { SessionNotification } from "@agentclientprotocol/sdk";
import { getModel } from "@mariozechner/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { createInProcessAcpPair } from "@test/helpers/in-process-connection.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";
import { createCliAgent } from "@/agent.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

const cleanupQueue: CliTestHarness[] = [];

afterEach(async () => {
	for (const h of cleanupQueue) await h.cleanup();
	cleanupQueue.length = 0;
});

async function fresh(): Promise<CliTestHarness> {
	const h = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	cleanupQueue.push(h);
	return h;
}

test("session history survives CLI restart", async () => {
	const h1 = await fresh();
	await h1.clientConn.initialize(stdInitParams);
	const { sessionId } = await h1.clientConn.newSession({ cwd: h1.tmpDir, mcpServers: [] });
	// We don't assert on the line-1 reply text — it's just to seed the session.
	// The substantive persistence proof is the post-restart replay + recall below.
	await h1.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "My secret number is 77." }],
	});

	// Second agent wired to the same db and tmpDir
	const model = getModel("openai", "gpt-4o-mini");
	const agent2 = createCliAgent({
		cwd: h1.tmpDir,
		dbPath: h1.dbPath,
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? OPENAI_KEY : undefined),
	});
	const updates2: SessionNotification[] = [];
	const { clientConn: conn2 } = createInProcessAcpPair(agent2.factory, () => ({
		sessionUpdate: async (p) => {
			updates2.push(p);
		},
		requestPermission: async () => ({ outcome: { outcome: "approved" } }),
	}));
	await conn2.initialize(stdInitParams);
	await conn2.loadSession({ sessionId, cwd: h1.tmpDir, mcpServers: [] });

	// Session replay emits the user message back as a notification — confirms
	// SQLite persistence + cross-instance reload.
	expect(chunkedAgentText(updates2) + JSON.stringify(updates2)).toContain("secret number is 77");

	// Continue the resumed session — history context must be intact.
	await conn2.prompt({
		sessionId,
		prompt: [{ type: "text", text: "What was my secret number? Reply with only the digits." }],
	});
	expect(chunkedAgentText(updates2)).toContain("77");
});
