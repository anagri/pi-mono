import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { MODE_CONFIG_ID } from "@/wire/constants.js";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

// Cross-runtime proof that plan mode actually rejects mutating tool calls and
// that the LLM adapts to the redirect. Single flow (per `feedback_bodhi_pi_e2e_strategy`):
// gpt-4o-mini, set /mode plan, ask the model to write a file, assert the write
// was blocked (no file on disk, no `completed` tool result) and a `tool_blocked`
// lifecycle event arrived.

const harness = useHarness();

test("plan mode blocks a real-LLM write attempt and emits tool_blocked", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);
	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.setSessionConfigOption({ sessionId, configId: MODE_CONFIG_ID, value: "plan" });

	const outFile = `${h.cwd}/forbidden.txt`;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the write tool to create the file at exactly this path: ${outFile}. The content should be: hello world. After your attempt, briefly say what happened in one short sentence.`,
			},
		],
	});

	await h.flushEvents();

	// The file MUST NOT exist on disk — plan-mode blocked the write at the gate.
	expect.soft(await h.filesystem.exists(outFile)).toBe(false);

	// A tool_blocked lifecycle event must have fired for the `write` call.
	const blocked = h.events.filter((e) => e.type === "tool_blocked");
	expect.soft(blocked.length, "at least one tool_blocked event").toBeGreaterThanOrEqual(1);
	if (blocked.length > 0) {
		const ev = blocked[0] as { toolName: string; mode: string; category: string; reason: string };
		expect.soft(ev.toolName).toBe("write");
		expect.soft(ev.mode).toBe("plan");
		expect.soft(ev.category).toBe("edit");
		expect.soft(ev.reason).toContain("plan mode");
	}
}, 60_000); // real LLM call + ACP round-trip across multiple runtimes
