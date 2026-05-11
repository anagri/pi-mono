import path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { toolCallUpdates } from "@test/helpers/tool-call-asserts.js";
import { afterEach, expect, test, vi } from "vitest";
import { createRenderer } from "@/repl/render.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

afterEach(async () => {
	await harness?.cleanup();
});

test("a failing read surfaces as tool_call_update.status='failed' AND the renderer prints the red ✗ line", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });

	// Pipe every notification through a real renderer (the same one cli.ts uses)
	// so we can assert what a human user would see in the REPL output.
	const renderer = createRenderer();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	const watched: SessionNotification[] = [];
	const watchedPushOriginal = harness.updates.push.bind(harness.updates);
	harness.updates.push = ((...items: SessionNotification[]) => {
		for (const u of items) {
			watched.push(u);
			renderer.onNotification(u);
		}
		return watchedPushOriginal(...items);
	}) as typeof harness.updates.push;

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });
	const missing = path.join(harness.tmpDir, "missing.txt");
	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the read tool to read ${missing}. That file does NOT exist, so the read MUST fail. After the failure, reply with exactly the words: file-missing`,
			},
		],
	});
	renderer.flush();

	// Agent contract: at least one tool_call_update lands as failed.
	const failed = toolCallUpdates(harness.updates).filter((u) => u.status === "failed");
	expect(failed.length, "expected at least one failed tool_call_update").toBeGreaterThanOrEqual(1);

	// Renderer contract: the red ✗ marker appears on stdout.
	const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(out).toContain("✗");

	// Assistant follows up with the agreed phrase.
	expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("file-missing");

	writeSpy.mockRestore();
});
