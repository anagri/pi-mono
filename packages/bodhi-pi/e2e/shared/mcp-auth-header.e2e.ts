import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

function authMcpUrl(): string {
	const url = process.env.BODHI_PI_E2E_MCP_AUTH_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_MCP_AUTH_HTTP_URL not set (global-setup must spawn auth-mcp-server)");
	return url;
}

function authMcpToken(): string {
	const tok = process.env.BODHI_PI_E2E_MCP_AUTH_TOKEN;
	if (!tok) throw new Error("BODHI_PI_E2E_MCP_AUTH_TOKEN not set");
	return tok;
}

test("mcp http-param header: connect succeeds with correct Authorization header and whoami reports header", async () => {
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

	const { slug } = await h.client.mcpAdd({
		url: authMcpUrl(),
		auth: "http-param",
		headers: { Authorization: `Bearer ${authMcpToken()}` },
	});

	const connected = await h.client.mcpConnect({ slug });
	expect.soft(connected.tools).toContain(`${slug}__whoami`);

	await h.client.mcpInclude({ slug, sessionId });
	const tools = await h.client.mcpTools({ slug, sessionId });
	expect.soft(tools).toContain(`${slug}__whoami`);

	// /mcp list masks the header value at the ACP boundary.
	const listed = await h.client.mcpList();
	const entry = listed.find((e) => e.slug === slug);
	const entryAuth = entry?.auth as { mode: string; headers?: Array<{ name: string; value: string }> } | undefined;
	expect.soft(entryAuth?.mode).toBe("http-param");
	expect.soft(entryAuth?.headers?.[0]).toEqual({ name: "Authorization", value: "***", secret: true });
});

test("mcp http-param header: connect rejects when bearer token is wrong", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => "ignored-no-prompts",
		}),
	);
	await h.clientConn.initialize(stdInitParams);
	await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const { slug } = await h.client.mcpAdd({
		url: authMcpUrl(),
		auth: "http-param",
		headers: { Authorization: `Bearer wrong-token-xyz` },
	});

	await expect(h.client.mcpConnect({ slug })).rejects.toThrow();
});

test("mcp http-param header: LLM invokes whoami and gets 'authenticated via header' back", async () => {
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

	const { slug } = await h.client.mcpAdd({
		url: authMcpUrl(),
		auth: "http-param",
		headers: { Authorization: `Bearer ${authMcpToken()}` },
	});
	await h.client.mcpConnect({ slug });
	await h.client.mcpInclude({ slug, sessionId });

	const result = await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Call the tool "${slug}__whoami" with no arguments and reply with exactly the tool's text result.`,
			},
		],
	});
	expect.soft(result.stopReason).toBe("end_turn");
	expect.soft(chunkedAgentText(h.updates)).toContain("authenticated via header");
}, 60_000);
