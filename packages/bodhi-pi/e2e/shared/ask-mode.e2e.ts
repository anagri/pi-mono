import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";
import { useHarness } from "../helpers/use-harness.js";

// Cross-runtime proof that ask mode runs the approval round-trip end-to-end: gpt-4o-mini in the
// default ask mode is asked to write a file; the Client side auto-approves (allow_once); assert the
// file landed and a `tool_approval_response{allow_once}` lifecycle event arrived. Skipped under
// `http` — its SSE transport cannot carry the server→client `requestPermission` request (WS does).

const harness = useHarness();

test.runIf(!isRuntime("http"))(
	"ask mode approves a real-LLM write and emits tool_approval_response{allow_once}",
	async () => {
		const model = getModel("openai", "gpt-4o-mini");
		const h = harness.set(
			await createE2EHarness({
				models: [model],
				defaultModelId: model.id,
				getApiKey: envKeysFor("openai"),
			}),
		);
		await h.clientConn.initialize(stdInitParams);
		// No setSessionConfigOption — ask is the default mode.
		const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

		const outFile = `${h.cwd}/approved.txt`;
		await h.clientConn.prompt({
			sessionId,
			prompt: [
				{
					type: "text",
					text: `Emit a single call to the \`write\` tool with path=${outFile} and content="hello world" before saying anything. The runtime intercepts the call; just emit it.`,
				},
			],
		});

		await h.flushEvents();

		// The Client auto-approved, so the write reached disk.
		expect.soft(await h.filesystem.exists(outFile)).toBe(true);

		// A tool_approval_response (allow_once) lifecycle event must have fired.
		const responses = h.events.filter((e) => e.type === "tool_approval_response");
		expect.soft(responses.length, "at least one tool_approval_response event").toBeGreaterThanOrEqual(1);
		if (responses.length > 0) {
			const ev = responses[0] as { toolName: string; kind: string };
			expect.soft(ev.toolName).toBe("write");
			expect.soft(ev.kind).toBe("allow_once");
		}
	},
	60_000, // real LLM call + ACP round-trip across multiple runtimes
);
