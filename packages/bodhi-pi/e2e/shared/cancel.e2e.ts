import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { afterEach, expect, test } from "vitest";
import { type AimockFixture, startAimockProvider } from "../helpers/aimock-fixture.js";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

// Cancellation produces `stopReason: "cancelled"` regardless of transport.
// Two complementary tests, both running across all four runtimes via aimock:
//   * Test A (deterministic): aimock streams a long mocked response at a known
//     tokens/second cadence so we can land a cancel mid-stream. Provider is
//     configured over the ACP wire via `_bodhi-pi/kv/set` (auth/openai with
//     base_url only — keyless), so the agent's existing OpenAI catalog model
//     gets its baseUrl rewritten to the aimock URL.
//   * Test B (real LLM): runs the same flow against gpt-4o-mini and cancels at
//     ~600ms. Robust to per-runtime cancel paths (in-process abort vs ACP
//     `session/cancel` over stdio vs HTTP SSE controller abort vs WS frame).

let activeHarness: E2EHarness | undefined;
let activeMock: AimockFixture | undefined;

afterEach(async () => {
	// Best-effort cleanup of auth/openai — http's test-app shares one on-disk KV
	// across all tests, so a leaked override here breaks every subsequent test
	// that expects pi-ai's default openai endpoint.
	if (activeHarness) {
		try {
			await activeHarness.clientConn.extMethod("_bodhi-pi/kv/remove", { key: "auth/openai" });
		} catch {
			// connection may already be torn down; ignore
		}
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
	if (activeMock) {
		await activeMock.cleanup();
		activeMock = undefined;
	}
});

test("cancel (aimock): mid-stream cancel resolves prompt with stopReason='cancelled'", async () => {
	const mock = await startAimockProvider();
	activeMock = mock;
	mock.mock.onMessage(
		/.*/,
		{
			content:
				"zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty",
		},
		{ streamingProfile: { tps: 4 } },
	);

	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => undefined,
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	// Provider auth must land BEFORE newSession — the agent resolves model.baseUrl
	// (overridden via auth/<provider>.base_url) at session bootstrap.
	await h.clientConn.extMethod("_bodhi-pi/kv/set", {
		key: "auth/openai",
		value: mock.providerValue,
	});
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const promptP = h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Count up." }],
	});
	await new Promise((r) => setTimeout(r, 600));
	await h.clientConn.cancel({ sessionId });
	const result = await promptP;
	expect(result.stopReason).toBe("cancelled");
});

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
	// arrives by ~200ms, full response takes 10s+.
	await new Promise((r) => setTimeout(r, 600));
	await h.clientConn.cancel({ sessionId });
	const result = await promptP;
	expect(result.stopReason).toBe("cancelled");
});
