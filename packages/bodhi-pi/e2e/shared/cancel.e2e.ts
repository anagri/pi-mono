import { type Api, fauxAssistantMessage, getModel, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";

// Cancellation produces `stopReason: "cancelled"` regardless of transport.
// Two complementary tests:
//   * Test A (in-memory only, faux provider): deterministic mid-stream cancel
//     using pi-ai's `registerFauxProvider` with throttled streaming. The faux
//     is registered globally in the test process, so it only reaches the
//     agent under in-memory; cli/http spawn a separate process.
//   * Test B (all runtimes, real LLM): runs a long-streaming prompt against
//     gpt-4o-mini and cancels at ~400ms. Robust to per-runtime cancel paths
//     (in-process abort vs ACP `session/cancel` over stdio vs HTTP cancel
//     translated into the SSE controller's abort).

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test.runIf(isRuntime("in-memory"))(
	"cancel (faux): mid-stream cancel resolves prompt with stopReason='cancelled'",
	async () => {
		const faux = registerFauxProvider({ tokensPerSecond: 4, tokenSize: { min: 1, max: 1 } });
		try {
			faux.setResponses([
				fauxAssistantMessage(
					"zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty",
				),
			]);

			const model = faux.getModel() as Model<Api>;
			const h = await createE2EHarness({
				models: [model],
				defaultModelId: model.id,
				getApiKey: () => "faux-key",
			});
			activeHarness = h;

			await h.clientConn.initialize(stdInitParams);
			const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

			const promptP = h.clientConn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Count up." }],
			});
			// Give the faux a chance to emit a couple of chunks before cancelling.
			await new Promise((r) => setTimeout(r, 500));
			await h.clientConn.cancel({ sessionId });
			const result = await promptP;
			expect(result.stopReason).toBe("cancelled");

			await h.flushEvents();
			const messageUpdates = h.events.filter((e) => e.type === "message_update");
			expect.soft(messageUpdates.length, "expected some streamed chunks before cancel").toBeGreaterThan(0);
		} finally {
			faux.unregister();
		}
	},
);

test("cancel (real LLM): mid-stream cancel resolves prompt with stopReason='cancelled'", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? process.env.OPENAI_API_KEY! : undefined),
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const promptP = h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Count from 1 to 200, one number per line, with a one-sentence reflection after each number.",
			},
		],
	});
	// 600ms in is plenty of margin: first chunk under all 3 runtimes typically
	// arrives by ~200ms, full response takes 10s+. Cancelling mid-stream.
	await new Promise((r) => setTimeout(r, 600));
	await h.clientConn.cancel({ sessionId });
	const result = await promptP;
	expect(result.stopReason).toBe("cancelled");
});
