import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

function mcpEverythingUrl(): string {
	const url = process.env.BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL not set (global-setup must spawn mcp-everything)");
	return url;
}

test("mcp public+http: add → connect → tools → disconnect → reconnect → remove (via _bodhi-pi/mcp/*)", async () => {
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

	const added = await h.client.mcpAdd({ url: mcpEverythingUrl() });
	expect.soft(added.slug.length).toBeGreaterThan(0);
	const slug = added.slug;

	const listed = await h.client.mcpList();
	const entry = listed.find((e) => e.slug === slug);
	expect.soft(entry?.status).toBe("disconnected");
	expect.soft(entry?.transport).toBe("http");

	const connectResult = await h.client.mcpConnect({ slug, sessionId });
	expect.soft(connectResult.tools).toContain(`${slug}__get-sum`);

	const tools = await h.client.mcpTools({ slug, sessionId });
	expect.soft(tools).toEqual(connectResult.tools);

	const listedAfterConnect = await h.client.mcpList();
	expect.soft(listedAfterConnect.find((e) => e.slug === slug)?.status).toBe("connected");

	await h.client.mcpDisconnect({ slug, sessionId });
	expect.soft(await h.client.mcpTools({ slug, sessionId })).toEqual([]);

	const reconnected = await h.client.mcpReconnect({ slug, sessionId });
	expect.soft(reconnected.tools).toContain(`${slug}__get-sum`);

	await h.client.mcpRemove({ slug, sessionId });
	expect.soft((await h.client.mcpList()).find((e) => e.slug === slug)).toBeUndefined();
});

test("mcp public+http: LLM prompts agent to use get-sum(20, 22) and gets 42 streamed back", async () => {
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

	const { slug } = await h.client.mcpAdd({ url: mcpEverythingUrl() });
	const connectResult = await h.client.mcpConnect({ slug, sessionId });
	expect.soft(connectResult.tools).toContain(`${slug}__get-sum`);

	const result = await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Using the everything-mcp tool "${slug}__get-sum", find the sum of 20 and 22. Reply with just the number.`,
			},
		],
	});
	expect.soft(result.stopReason).toBe("end_turn");

	const sumCall = h.updates
		.filter((u) => u.update.sessionUpdate === "tool_call")
		.find((u) => {
			const update = u.update as { title?: string };
			return typeof update.title === "string" && update.title.startsWith(`${slug}__get-sum`);
		});
	expect.soft(sumCall).toBeDefined();
	if (sumCall) {
		const input = (sumCall.update as { rawInput?: { a?: number; b?: number } }).rawInput;
		expect.soft(input?.a).toBe(20);
		expect.soft(input?.b).toBe(22);
	}

	const sumResult = h.updates
		.filter((u) => u.update.sessionUpdate === "tool_call_update")
		.find((u) => {
			const c = (u.update as { content?: Array<{ type?: string; content?: { text?: string } }> }).content;
			return Array.isArray(c) && c.some((b) => b?.content?.text?.includes("42"));
		});
	expect.soft(sumResult).toBeDefined();

	expect.soft(chunkedAgentText(h.updates)).toContain("42");
}, 60_000);

// http rebuilds the agent per request, dropping the in-memory McpRegistry between
// session/new (where ephemeral mcpServers connect) and the follow-up _bodhi-pi/mcp/tools.
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

		const url = mcpEverythingUrl();
		const { sessionId } = await h.clientConn.newSession({
			cwd: h.cwd,
			mcpServers: [{ type: "http", name: "ephemeral-everything", url, headers: [] }],
		});

		const slug = "ephemeral-everything";
		const tools = await h.client.mcpTools({ slug, sessionId });
		expect.soft(tools).toContain(`${slug}__get-sum`);

		const kvList = await h.client.kv.list({ prefix: "mcp/" });
		expect.soft(kvList.entries.find((e) => e.key === `mcp/${slug}`)).toBeUndefined();
	},
);
