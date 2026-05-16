import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

// Hardcoded deepwiki URL — public hosted MCP used as the second MCP in
// multi-MCP tests. Stable; no env-var indirection needed.
const DEEPWIKI_URL = "https://mcp.deepwiki.com/mcp";

function mcpEverythingUrl(): string {
	const url = process.env.BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL not set");
	return url;
}

test("mcp multi: two MCPs added + connected; only one included; /mcp include adds the second", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => "ignored-no-prompts",
		}),
	);
	await h.clientConn.initialize(stdInitParams);

	const a = await h.client.mcpAdd({ url: mcpEverythingUrl(), label: "everything" });
	const b = await h.client.mcpAdd({ url: DEEPWIKI_URL, label: "deepwiki" });
	await h.client.mcpConnect({ slug: a.slug });
	await h.client.mcpConnect({ slug: b.slug });

	// Open session including only A; B is connected globally but not in this session's set.
	const { sessionId } = await h.clientConn.newSession({
		cwd: h.cwd,
		mcpServers: [{ type: "http", name: a.slug, url: mcpEverythingUrl(), headers: [] }],
	});

	const aTools = await h.client.mcpTools({ slug: a.slug, sessionId });
	expect.soft(aTools).toContain(`${a.slug}__get-sum`);
	const bToolsBefore = await h.client.mcpTools({ slug: b.slug, sessionId });
	expect.soft(bToolsBefore).toEqual([]);

	// /mcp include B: tools now visible without any new connection.
	const includeResult = await h.client.mcpInclude({ slug: b.slug, sessionId });
	expect.soft(includeResult.tools.length).toBeGreaterThan(0);
	const bToolsAfter = await h.client.mcpTools({ slug: b.slug, sessionId });
	expect.soft(bToolsAfter.length).toBeGreaterThan(0);
});

test("mcp multi: empty-array mcpServers means session sees zero MCP tools", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => "ignored-no-prompts",
		}),
	);
	await h.clientConn.initialize(stdInitParams);

	const { slug } = await h.client.mcpAdd({ url: mcpEverythingUrl() });
	await h.client.mcpConnect({ slug });

	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	const tools = await h.client.mcpTools({ slug, sessionId });
	expect.soft(tools).toEqual([]);

	// /mcp include opts back in.
	const inc = await h.client.mcpInclude({ slug, sessionId });
	expect.soft(inc.tools).toContain(`${slug}__get-sum`);
});

test("mcp multi: /mcp include of unknown slug rejects with RequestError", async () => {
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

	await expect(h.client.mcpInclude({ slug: "no-such-slug", sessionId })).rejects.toThrow(/unknown mcp/);
});

test("mcp multi: LLM uses tools from BOTH connected+included MCPs in one prompt", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);
	await h.clientConn.initialize(stdInitParams);

	const a = await h.client.mcpAdd({ url: mcpEverythingUrl(), label: "everything" });
	const b = await h.client.mcpAdd({ url: DEEPWIKI_URL, label: "deepwiki" });
	await h.client.mcpConnect({ slug: a.slug });
	await h.client.mcpConnect({ slug: b.slug });

	const { sessionId } = await h.clientConn.newSession({
		cwd: h.cwd,
		mcpServers: [
			{ type: "http", name: a.slug, url: mcpEverythingUrl(), headers: [] },
			{ type: "http", name: b.slug, url: DEEPWIKI_URL, headers: [] },
		],
	});

	const result = await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text:
					`Two things in one turn:\n` +
					`1) Call the tool ${a.slug}__get-sum with a=20, b=22 and report the number.\n` +
					`2) Call any deepwiki tool (e.g. ${b.slug}__ask_question with repoName="facebook/react" and question="What is React?") and include a short snippet of the answer.\n` +
					`Reply briefly.`,
			},
		],
	});
	expect.soft(result.stopReason).toBe("end_turn");

	const aCall = h.updates
		.filter((u) => u.update.sessionUpdate === "tool_call")
		.find((u) => (u.update as { title?: string }).title?.startsWith(`${a.slug}__`));
	expect.soft(aCall).toBeDefined();

	const bCall = h.updates
		.filter((u) => u.update.sessionUpdate === "tool_call")
		.find((u) => (u.update as { title?: string }).title?.startsWith(`${b.slug}__`));
	expect.soft(bCall).toBeDefined();

	expect.soft(chunkedAgentText(h.updates)).toContain("42");
}, 90_000);
