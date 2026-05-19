import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_SESSION_CONFIG, MODE_CONFIG_ID, MODEL_CONFIG_ID, THINKING_CONFIG_ID } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];
let recorded: { reasoning?: string | undefined }[] = [];

beforeEach(() => {
	providers = [];
	recorded = [];
});
afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function reasoningModel(modelId = "reasoning-model"): Model<Api> {
	const faux = registerFauxProvider({ models: [{ id: modelId, reasoning: true }] });
	providers.push(faux);
	const record = (options: unknown) => {
		const reasoning = (options as { reasoning?: string } | undefined)?.reasoning;
		recorded.push({ reasoning });
	};
	faux.setResponses([
		(_ctx, options) => {
			record(options);
			return fauxAssistantMessage("ok");
		},
		(_ctx, options) => {
			record(options);
			return fauxAssistantMessage("ok2");
		},
		(_ctx, options) => {
			record(options);
			return fauxAssistantMessage("ok3");
		},
	]);
	return faux.getModel() as Model<Api>;
}

function plainModel(): Model<Api> {
	const faux = registerFauxProvider();
	providers.push(faux);
	faux.setResponses([() => fauxAssistantMessage("ok")]);
	return faux.getModel() as Model<Api>;
}

test("session/new advertises thinking option for reasoning model", async () => {
	const model = reasoningModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const res = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const ids = (res.configOptions ?? []).map((o: SessionConfigOption) => o.id);
	expect(ids).toEqual([MODE_CONFIG_ID, MODEL_CONFIG_ID, THINKING_CONFIG_ID]);
});

test("session/new omits thinking option for non-reasoning model", async () => {
	const model = plainModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const res = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const ids = (res.configOptions ?? []).map((o: SessionConfigOption) => o.id);
	expect(ids).toEqual([MODE_CONFIG_ID, MODEL_CONFIG_ID]);
});

test("setSessionConfigOption thinking returns full configOptions list (bug fix)", async () => {
	const model = reasoningModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const res = await harness.clientConn.setSessionConfigOption({
		sessionId,
		configId: THINKING_CONFIG_ID,
		value: "medium",
	});
	const ids = (res.configOptions ?? []).map((o: SessionConfigOption) => o.id);
	expect(ids).toEqual([MODE_CONFIG_ID, MODEL_CONFIG_ID, THINKING_CONFIG_ID]);
	const thinking = (res.configOptions ?? []).find((o: SessionConfigOption) => o.id === THINKING_CONFIG_ID);
	expect(thinking && "currentValue" in thinking ? thinking.currentValue : undefined).toBe("medium");
});

test("thinking-level flows to next turn via prepareNextTurn", async () => {
	const model = reasoningModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
	expect(recorded[0]?.reasoning).toBeUndefined();

	await harness.clientConn.setSessionConfigOption({
		sessionId,
		configId: THINKING_CONFIG_ID,
		value: "high",
	});
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] });
	expect(recorded[1]?.reasoning).toBe("high");
});

test("unsupported thinking level → RequestError -32602", async () => {
	const model = plainModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await expect(
		harness.clientConn.setSessionConfigOption({
			sessionId,
			configId: THINKING_CONFIG_ID,
			value: "high",
		}),
	).rejects.toThrow(/unsupported thinking level/);
});

test("BodhiPiConfig.defaultThinkingLevel applies to first turn (initial state)", async () => {
	const model = reasoningModel();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		defaultThinkingLevel: "high",
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
	expect(recorded[0]?.reasoning).toBe("high");
});

test("_bodhi-pi/session/config returns thinkingLevel", async () => {
	const model = reasoningModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.setSessionConfigOption({
		sessionId,
		configId: THINKING_CONFIG_ID,
		value: "low",
	});
	const result = (await harness.clientConn.extMethod(EXT_SESSION_CONFIG, { sessionId })) as {
		thinkingLevel: string;
	};
	expect(result.thinkingLevel).toBe("low");
});

test("resume restores thinkingLevel from thinking_change replay", async () => {
	const model = reasoningModel();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.setSessionConfigOption({
		sessionId,
		configId: THINKING_CONFIG_ID,
		value: "medium",
	});
	await harness.clientConn.closeSession({ sessionId });

	const res = await harness.clientConn.loadSession({ sessionId, cwd: "/proj", mcpServers: [] });
	const thinking = (res.configOptions ?? []).find((o: SessionConfigOption) => o.id === THINKING_CONFIG_ID);
	expect(thinking && "currentValue" in thinking ? thinking.currentValue : undefined).toBe("medium");
});
