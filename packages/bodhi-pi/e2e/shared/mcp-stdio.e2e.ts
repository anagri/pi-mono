import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

test.runIf(isRuntime("in-memory") || isRuntime("cli"))(
	"mcp stdio: add → connect → tools → disconnect → reconnect → remove (via _bodhi-pi/mcp/*)",
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
		const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

		const added = await h.client.mcpAdd({
			command: "npx",
			args: ["--yes", "@modelcontextprotocol/server-everything", "stdio"],
		});
		expect.soft(added.slug).toBe("server-everything");

		const connectResult = await h.client.mcpConnect({ slug: added.slug });
		expect.soft(connectResult.tools).toContain(`${added.slug}__get-sum`);

		await h.client.mcpInclude({ slug: added.slug, sessionId });
		const tools = await h.client.mcpTools({ slug: added.slug, sessionId });
		expect.soft(tools).toEqual(connectResult.tools);

		await h.client.mcpDisconnect({ slug: added.slug });
		expect.soft(await h.client.mcpTools({ slug: added.slug, sessionId })).toEqual([]);

		const reconnected = await h.client.mcpReconnect({ slug: added.slug });
		expect.soft(reconnected.tools).toContain(`${added.slug}__get-sum`);

		await h.client.mcpRemove({ slug: added.slug });
		expect.soft((await h.client.mcpList()).find((e) => e.slug === added.slug)).toBeUndefined();
	},
	60_000,
);

test.runIf(isRuntime("in-memory") || isRuntime("cli"))(
	"mcp stdio: LLM prompts agent to use get-sum(20, 22) over stdio MCP and gets 42",
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
		const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

		const { slug } = await h.client.mcpAdd({
			command: "npx",
			args: ["--yes", "@modelcontextprotocol/server-everything", "stdio"],
		});
		await h.client.mcpConnect({ slug });
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

		const sumResult = h.updates
			.filter((u) => u.update.sessionUpdate === "tool_call_update")
			.find((u) => {
				const c = (u.update as { content?: Array<{ type?: string; content?: { text?: string } }> }).content;
				return Array.isArray(c) && c.some((b) => b?.content?.text?.includes("42"));
			});
		expect.soft(sumResult).toBeDefined();
		expect.soft(chunkedAgentText(h.updates)).toContain("42");
	},
	90_000,
);

test.runIf(isRuntime("http") || isRuntime("ws") || isRuntime("browser") || isRuntime("chrome-ext"))(
	"mcp stdio: `/mcp/add command=…` rejects cleanly on runtimes that gate stdio (supportsMcpStdio=false)",
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
		await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

		await expect(
			h.client.mcpAdd({ command: "npx", args: ["@modelcontextprotocol/server-everything"] }),
		).rejects.toThrow(/stdio MCPs are not supported/);
	},
);
