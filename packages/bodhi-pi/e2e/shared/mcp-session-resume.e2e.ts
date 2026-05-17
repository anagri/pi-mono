import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

function mcpEverythingUrl(): string {
	const url = process.env.BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL not set (global-setup must spawn mcp-everything)");
	return url;
}

// Cross-runtime contract: closing + resuming a session restores the previously
// included MCPs from the session-persisted `mcp_inclusion_set` entry, just like
// model selection. Runs across in-memory/cli/http/ws projects. http relies on
// the host's server-level connection store (slice 3); long-lived runtimes use
// the SDK's default in-process provider.
test("mcp session resume: closing + resuming restores included MCPs", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => "ignored-no-prompts",
		}),
	);
	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const { slug } = await h.client.mcpAdd({ url: mcpEverythingUrl(), auth: "public" });
	const connectResult = await h.client.mcpConnect({ slug });
	expect.soft(connectResult.tools).toContain(`${slug}__get-sum`);
	await h.client.mcpInclude({ slug, sessionId });

	const toolsBefore = await h.client.mcpTools({ slug, sessionId });
	expect.soft(toolsBefore).toContain(`${slug}__get-sum`);

	// Drop in-memory inclusion via session/close. Connection survives at host level.
	await h.clientConn.closeSession({ sessionId });

	// Resume with mcpServers omitted: SDK falls back to session-stored inclusion.
	await h.clientConn.resumeSession({ sessionId, cwd: h.cwd } as never);

	const toolsAfter = await h.client.mcpTools({ slug, sessionId });
	expect.soft(toolsAfter).toEqual(toolsBefore);
});
