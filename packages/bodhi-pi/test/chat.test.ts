import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import { LLMock } from "@copilotkit/aimock";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createBodhiPiAgent } from "../src/index.js";
import { createInProcessAcpPair } from "./helpers/in-process-connection.js";

type SelectOption = SessionConfigOption & { type: "select" };

function chunkedAgentText(updates: SessionNotification[]): string {
	return updates
		.filter((u) => u.update.sessionUpdate === "agent_message_chunk")
		.map((u) => {
			const content = (u.update as { content: { type: string; text?: string } }).content;
			return content.type === "text" ? (content.text ?? "") : "";
		})
		.join("");
}

function asSelectOption(opt: SessionConfigOption | undefined): SelectOption {
	expect(opt, "expected a SessionConfigOption").toBeDefined();
	expect(opt?.type).toBe("select");
	return opt as SelectOption;
}

let mocks: LLMock[] = [];

beforeEach(() => {
	mocks = [];
});

afterEach(async () => {
	await Promise.all(mocks.map((m) => m.stop()));
	mocks = [];
});

async function startMock(): Promise<LLMock> {
	const mock = new LLMock({ port: 0 });
	await mock.start();
	mocks.push(mock);
	return mock;
}

test("simple chat round-trips via ACP through aimock", async () => {
	const mock = await startMock();
	mock.onMessage(/Monday/i, { content: "tuesday" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const updates: SessionNotification[] = [];

	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
			defaultModelId: baseModel.id,
			getApiKey: () => "test-key",
		}),
		() => ({
			sessionUpdate: async (params) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		}),
	);

	await clientConn.initialize({
		protocolVersion: 1,
		clientCapabilities: {
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
		},
	});

	const newSession = await clientConn.newSession({
		cwd: process.cwd(),
		mcpServers: [],
	});

	const modelOption = asSelectOption(newSession.configOptions?.[0]);
	expect(modelOption.id).toBe("model");
	expect(modelOption.currentValue).toBe(baseModel.id);
	expect(modelOption.options).toHaveLength(1);

	const result = await clientConn.prompt({
		sessionId: newSession.sessionId,
		prompt: [{ type: "text", text: "Answer in one word: what day comes after Monday?" }],
	});

	expect(result.stopReason).toBe("end_turn");
	expect(chunkedAgentText(updates).trim().toLowerCase()).toBe("tuesday");
});

test("switch model via setSessionConfigOption routes to second mock", async () => {
	const mockA = await startMock();
	const mockB = await startMock();
	mockA.onMessage(/.*/, { content: "from-a" });
	mockB.onMessage(/.*/, { content: "from-b" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const modelA: typeof baseModel = {
		...baseModel,
		id: "model-a",
		name: "Model A",
		baseUrl: `${mockA.url}/v1`,
	};
	const modelB: typeof baseModel = {
		...baseModel,
		id: "model-b",
		name: "Model B",
		baseUrl: `${mockB.url}/v1`,
	};

	const updates: SessionNotification[] = [];

	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: [modelA, modelB],
			defaultModelId: "model-a",
			getApiKey: () => "test-key",
		}),
		() => ({
			sessionUpdate: async (params) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		}),
	);

	await clientConn.initialize({
		protocolVersion: 1,
		clientCapabilities: {
			fs: { readTextFile: false, writeTextFile: false },
			terminal: false,
		},
	});

	const { sessionId, configOptions } = await clientConn.newSession({
		cwd: process.cwd(),
		mcpServers: [],
	});

	const initialOption = asSelectOption(configOptions?.[0]);
	expect(initialOption.currentValue).toBe("model-a");
	expect(initialOption.options).toHaveLength(2);

	// First prompt routes to model-a
	updates.length = 0;
	await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "anything" }],
	});
	expect(chunkedAgentText(updates).trim()).toBe("from-a");

	// Switch to model-b
	const switchResult = await clientConn.setSessionConfigOption({
		sessionId,
		configId: "model",
		value: "model-b",
	});
	const switched = asSelectOption(switchResult.configOptions[0]);
	expect(switched.currentValue).toBe("model-b");

	// Second prompt routes to model-b
	updates.length = 0;
	await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "anything else" }],
	});
	expect(chunkedAgentText(updates).trim()).toBe("from-b");
});
