import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { MODE_CONFIG_ID, MODEL_CONFIG_ID } from "@/wire/constants.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

// Wire-state proof for mode foundation across all transports.
// Phase 0 is intentionally inert (no policy enforcement); this exercises the
// observable surface only: mode advertised, mode change accepted, mode persists.
// Heavier e2e for the policy + approval round-trip lands in Phase 1.

const harness = useHarness();

function modeOption(options: readonly SessionConfigOption[] | null | undefined): SessionConfigOption | undefined {
	return options?.find((o) => o.id === MODE_CONFIG_ID) ?? undefined;
}

test("mode: default 'ask', /mode edit changes + persists across closeSession+loadSession", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => process.env.OPENAI_API_KEY!,
		}),
	);
	await h.clientConn.initialize(stdInitParams);
	const newSession = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const initialMode = modeOption(newSession.configOptions);
	expect.soft(initialMode?.category).toBe("mode");
	expect.soft(initialMode && "currentValue" in initialMode ? initialMode.currentValue : undefined).toBe("ask");
	const ids = (newSession.configOptions ?? []).map((o) => o.id);
	expect.soft(ids[0]).toBe(MODE_CONFIG_ID);
	expect.soft(ids).toContain(MODEL_CONFIG_ID);

	const switchResult = await h.clientConn.setSessionConfigOption({
		sessionId: newSession.sessionId,
		configId: MODE_CONFIG_ID,
		value: "edit",
	});
	const switched = modeOption(switchResult.configOptions);
	expect.soft(switched && "currentValue" in switched ? switched.currentValue : undefined).toBe("edit");

	await h.clientConn.closeSession({ sessionId: newSession.sessionId });
	const loaded = await h.clientConn.loadSession({ sessionId: newSession.sessionId, cwd: h.cwd, mcpServers: [] });
	const loadedMode = modeOption(loaded.configOptions);
	expect.soft(loadedMode && "currentValue" in loadedMode ? loadedMode.currentValue : undefined).toBe("edit");
});
