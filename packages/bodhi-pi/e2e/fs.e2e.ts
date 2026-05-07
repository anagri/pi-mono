import type { SessionNotification } from "@agentclientprotocol/sdk";
import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { expect, test } from "vitest";
import {
	createBodhiPiAgent,
	createInMemoryFilesystem,
	createInMemorySessionStore,
	type Filesystem,
} from "../src/index.js";
import { createInProcessAcpPair } from "../test/helpers/in-process-connection.js";

const stdInitParams = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;

function chunkedAgentText(updates: SessionNotification[]): string {
	return updates
		.filter((u) => u.update.sessionUpdate === "agent_message_chunk")
		.map((u) => {
			const content = (u.update as { content: { type: string; text?: string } }).content;
			return content.type === "text" ? (content.text ?? "") : "";
		})
		.join("");
}

function requireEnv(name: string): string {
	const value = process.env[name];
	expect(value, `${name} must be set in e2e/.env.test to run e2e tests`).toBeTruthy();
	return value as string;
}

interface Harness {
	clientConn: ReturnType<typeof createInProcessAcpPair>["clientConn"];
	updates: SessionNotification[];
	filesystem: Filesystem;
}

function makeHarness(opts: { model: Model<Api>; apiKey: string; provider: string; filesystem?: Filesystem }): Harness {
	const filesystem = opts.filesystem ?? createInMemoryFilesystem();
	const updates: SessionNotification[] = [];
	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: [opts.model],
			defaultModelId: opts.model.id,
			getApiKey: (p) => (p === opts.provider ? opts.apiKey : undefined),
			sessionStore: createInMemorySessionStore(),
			filesystem,
		}),
		() => ({
			sessionUpdate: async (params) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		}),
	);
	return { clientConn, updates, filesystem };
}

test("Haiku writes a file then reads it back", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");
	const harness = makeHarness({
		model: getModel("anthropic", "claude-haiku-4-5"),
		apiKey,
		provider: "anthropic",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Use the write tool to create the file /out.txt with exactly the text: hello world",
			},
		],
	});

	expect(await harness.filesystem.exists("/out.txt")).toBe(true);
	const stored = await harness.filesystem.readTextFile("/out.txt");
	expect(stored.trim()).toBe("hello world");

	harness.updates.length = 0;
	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Use the read tool on /out.txt and reply with the file's exact contents and nothing else.",
			},
		],
	});
	expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("hello world");
});

test("Haiku finds a string with grep", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");
	const filesystem = createInMemoryFilesystem();
	await filesystem.writeTextFile("/apple.txt", "this file has nothing of interest");
	await filesystem.writeTextFile("/banana.txt", "this file mentions banana once");
	await filesystem.writeTextFile("/cherry.txt", "another distractor file");

	const harness = makeHarness({
		model: getModel("anthropic", "claude-haiku-4-5"),
		apiKey,
		provider: "anthropic",
		filesystem,
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Use the grep tool to find which file under / contains the word 'banana'. Reply with just the matching file path and nothing else.",
			},
		],
	});

	expect(chunkedAgentText(harness.updates)).toContain("/banana.txt");
});
