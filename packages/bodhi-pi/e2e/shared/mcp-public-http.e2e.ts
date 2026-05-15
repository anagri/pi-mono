import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { createE2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";
import { useHarness } from "../helpers/use-harness.js";

// Coverage for the public + http-streamable MCP path through `_bodhi-pi/mcp/*`
// extension methods AND ACP-native `mcpServers` on `NewSessionRequest`.
//
// mcp-everything is spawned once in `global-setup.ts` and exposed via
// `BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL`. Tools are namespaced `<slug>__<tool>`;
// the `echo` tool is mcp-everything's well-known fixture.

const harness = useHarness();

function mcpEverythingUrl(): string {
	const url = process.env.BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL not set (global-setup must spawn mcp-everything)");
	return url;
}

test("mcp public+http: add → connect → tools (with echo) → disconnect → reconnect → remove (via _bodhi-pi/mcp/*)", async () => {
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

	// Step 1: add the MCP. Slug is derived from URL host; record persists.
	const added = await h.client.mcpAdd({ url: mcpEverythingUrl() });
	expect.soft(added.slug.length).toBeGreaterThan(0);
	const slug = added.slug;

	// Step 2: list shows the entry with status `disconnected` (no auto-connect on add).
	const listed = await h.client.mcpList();
	const entry = listed.find((e) => e.slug === slug);
	expect.soft(entry, `entry ${slug} present in list`).toBeDefined();
	expect.soft(entry?.status).toBe("disconnected");
	expect.soft(entry?.transport).toBe("http");

	// Step 3: connect. Returns the namespaced tool list; `echo` is present.
	const connectResult = await h.client.mcpConnect({ slug, sessionId });
	expect.soft(connectResult.tools.length).toBeGreaterThan(0);
	expect.soft(connectResult.tools).toContain(`${slug}__echo`);

	// Step 4: tools query (post-connect) reports the same names.
	const tools = await h.client.mcpTools({ slug, sessionId });
	expect.soft(tools).toEqual(connectResult.tools);

	// Step 5: list now reflects `connected` status.
	const listedAfterConnect = await h.client.mcpList();
	expect.soft(listedAfterConnect.find((e) => e.slug === slug)?.status).toBe("connected");

	// Step 6: disconnect. Tools should disappear from the session.
	await h.client.mcpDisconnect({ slug, sessionId });
	const toolsAfterDisconnect = await h.client.mcpTools({ slug, sessionId });
	expect.soft(toolsAfterDisconnect).toEqual([]);

	// Step 7: reconnect. Tools re-appear.
	const reconnected = await h.client.mcpReconnect({ slug, sessionId });
	expect.soft(reconnected.tools).toContain(`${slug}__echo`);

	// Step 8: remove. Subsequent list omits it.
	await h.client.mcpRemove({ slug, sessionId });
	const listedAfterRemove = await h.client.mcpList();
	expect.soft(listedAfterRemove.find((e) => e.slug === slug)).toBeUndefined();
});

// Ephemeral `mcpServers` from `NewSessionRequest` live only in the agent's
// in-memory `McpRegistry` for the current process. The http runtime rebuilds
// the agent on every HTTP request, so the registry from session/new is gone
// by the time `_bodhi-pi/mcp/tools` lands. Skipped under http; covered by all
// other runtimes that maintain a stateful agent across calls.
test.runIf(!isRuntime("http"))(
	"mcp public+http: ACP-native `mcpServers` on session/new hydrates ephemeral MCPs",
	async () => {
		const model = getModel("openai", "gpt-4o-mini");
		const h = harness.set(
			await createE2EHarness({
				models: [model],
				defaultModelId: model.id,
				getApiKey: () => "ignored-no-prompts",
			}),
		);
		await h.clientConn.initialize(stdInitParams);

		// Pass mcp-everything directly through ACP's native `mcpServers` field.
		// The agent should accept the entry, connect, and expose tools — without
		// any persisted `mcp/*` kv entry.
		const url = mcpEverythingUrl();
		const { sessionId } = await h.clientConn.newSession({
			cwd: h.cwd,
			mcpServers: [{ type: "http", name: "ephemeral-everything", url, headers: [] }],
		});

		// The ephemeral entry uses `ephemeral-everything` as slug (sanitized).
		const slug = "ephemeral-everything";
		const tools = await h.client.mcpTools({ slug, sessionId });
		expect.soft(tools).toContain(`${slug}__echo`);

		// kv must NOT contain a persisted entry for the ephemeral connection.
		const kvList = await h.client.kv.list({ prefix: "mcp/" });
		expect.soft(kvList.entries.find((e) => e.key === `mcp/${slug}`)).toBeUndefined();
	},
);
