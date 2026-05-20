import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { newAllowAllSession } from "../helpers/allow-all-session.js";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

function mcpEverythingUrl(): string {
	const url = process.env.BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL not set (global-setup must spawn mcp-everything)");
	return url;
}

test("mcp public+http: add → connect → include → tools → disconnect → reconnect → remove", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => "ignored-no-prompts",
		}),
	);
	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await newAllowAllSession(h.clientConn, { cwd: h.cwd, mcpServers: [] });

	const added = await h.client.mcpAdd({ url: mcpEverythingUrl(), auth: "public" });
	expect.soft(added.slug.length).toBeGreaterThan(0);
	const slug = added.slug;

	const listed = await h.client.mcpList();
	const entry = listed.find((e) => e.slug === slug);
	expect.soft(entry?.status).toBe("disconnected");
	expect.soft(entry?.transport).toBe("http");

	const connectResult = await h.client.mcpConnect({ slug });
	expect.soft(connectResult.tools).toContain(`${slug}__get-sum`);

	// connect is global — this session sees nothing until /mcp include
	expect.soft(await h.client.mcpTools({ slug, sessionId })).toEqual([]);

	const includeResult = await h.client.mcpInclude({ slug, sessionId });
	expect.soft(includeResult.tools).toEqual(connectResult.tools);

	const tools = await h.client.mcpTools({ slug, sessionId });
	expect.soft(tools).toEqual(connectResult.tools);

	const listedAfterConnect = await h.client.mcpList();
	expect.soft(listedAfterConnect.find((e) => e.slug === slug)?.status).toBe("connected");

	await h.client.mcpDisconnect({ slug });
	expect.soft(await h.client.mcpTools({ slug, sessionId })).toEqual([]);

	const reconnected = await h.client.mcpReconnect({ slug });
	expect.soft(reconnected.tools).toContain(`${slug}__get-sum`);
	expect.soft(await h.client.mcpTools({ slug, sessionId })).toEqual(reconnected.tools);

	await h.client.mcpRemove({ slug });
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
	const { sessionId } = await newAllowAllSession(h.clientConn, { cwd: h.cwd, mcpServers: [] });

	const { slug } = await h.client.mcpAdd({ url: mcpEverythingUrl(), auth: "public" });
	const connectResult = await h.client.mcpConnect({ slug });
	expect.soft(connectResult.tools).toContain(`${slug}__get-sum`);
	await h.client.mcpInclude({ slug, sessionId });

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

test("mcp public+http: ACP-native `mcpServers: [name]` on session/new connects + includes by slug reference", async () => {
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
	const { slug } = await h.client.mcpAdd({ url, auth: "public", label: "everything-by-name" });

	const { sessionId } = await newAllowAllSession(h.clientConn, {
		cwd: h.cwd,
		mcpServers: [{ type: "http", name: slug, url, headers: [] }],
	});

	const tools = await h.client.mcpTools({ slug, sessionId });
	expect.soft(tools).toContain(`${slug}__get-sum`);

	const listed = await h.client.mcpList();
	expect.soft(listed.find((e) => e.slug === slug)?.status).toBe("connected");
});

test("mcp public+http: unknown slug in session/new mcpServers is silently ignored (no kv promotion)", async () => {
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
	const { sessionId } = await newAllowAllSession(h.clientConn, {
		cwd: h.cwd,
		mcpServers: [{ type: "http", name: "unknown-slug-xyz", url, headers: [] }],
	});

	const tools = await h.client.mcpTools({ slug: "unknown-slug-xyz", sessionId });
	expect.soft(tools).toEqual([]);

	const kvList = await h.client.kv.list({ prefix: "mcp/" });
	expect.soft(kvList.entries.find((e) => e.key === `mcp/unknown-slug-xyz`)).toBeUndefined();
});
