import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { expect, test } from "vitest";
import { createE2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";
import { useHarness } from "../helpers/use-harness.js";

// Coverage for stdio-transport MCP via `_bodhi-pi/mcp/*`. Drives `mcp-everything`
// as a stdio child process (npx). Limited to in-memory and cli — per scope
// clamp, http/ws/browser/chrome-ext don't spawn child processes (browser/ext
// can't, http/ws stateless rebuild can't reuse them).

const harness = useHarness();

test.runIf(isRuntime("in-memory") || isRuntime("cli"))(
	"mcp stdio: add → connect → tools (with echo) → disconnect → reconnect → remove (via _bodhi-pi/mcp/*)",
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

		const connectResult = await h.client.mcpConnect({ slug: added.slug, sessionId });
		expect.soft(connectResult.tools).toContain(`${added.slug}__echo`);

		const tools = await h.client.mcpTools({ slug: added.slug, sessionId });
		expect.soft(tools).toEqual(connectResult.tools);

		await h.client.mcpDisconnect({ slug: added.slug, sessionId });
		const toolsAfterDisconnect = await h.client.mcpTools({ slug: added.slug, sessionId });
		expect.soft(toolsAfterDisconnect).toEqual([]);

		const reconnected = await h.client.mcpReconnect({ slug: added.slug, sessionId });
		expect.soft(reconnected.tools).toContain(`${added.slug}__echo`);

		await h.client.mcpRemove({ slug: added.slug, sessionId });
		const listAfterRemove = await h.client.mcpList();
		expect.soft(listAfterRemove.find((e) => e.slug === added.slug)).toBeUndefined();
	},
	60_000, // 60s: stdio spawn (npx -y) can take ~10s on cold cache
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
