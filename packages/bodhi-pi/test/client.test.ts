import { getModel } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { createBodhiPiClient, modelConfigFromOptions } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

test("BodhiPiClient initializes and tracks active session config", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = createBodhiPiClient(harness.clientConn, { cwd: "/proj" });

	const init = await client.initialize(stdInitParams);
	expect(init.agentInfo?.name).toBe("bodhi-pi");

	const created = await client.newSession();
	expect(client.sessionId).toBe(created.sessionId);
	expect(modelConfigFromOptions(created.configOptions ?? undefined).currentModelId).toBe(model.id);
	expect(client.models().currentModelId).toBe(model.id);
	expect(client.models().models.map((m) => m.id)).toContain(model.id);
});

test("BodhiPiClient stores, lists, reads, and removes provider auth", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = createBodhiPiClient(harness.clientConn, { cwd: "/proj" });

	await client.initialize(stdInitParams);
	await client.newSession();

	const added = await client.addProvider("openai", "sk-test");
	expect(added).toEqual({ key: "auth/openai", secret: true });

	await expect(client.getProvider("openai")).resolves.toEqual({
		provider: "openai",
		value: "***",
		secret: true,
	});
	await expect(client.listProviders()).resolves.toEqual([{ provider: "openai", value: "***", secret: true }]);

	await expect(client.removeProvider("openai")).resolves.toEqual({ key: "auth/openai" });
	await expect(client.getProvider("openai")).resolves.toEqual({ provider: "openai", value: null, secret: false });
});

test("BodhiPiClient switches model through ACP config options", async () => {
	const modelA = getModel("openai", "gpt-5-mini");
	const modelB = { ...getModel("openai", "gpt-5"), id: "test-model-b", name: "Model B" };
	const harness = createTestHarness({ models: [modelA, modelB], defaultModelId: modelA.id });
	const client = createBodhiPiClient(harness.clientConn, { cwd: "/proj" });

	await client.initialize(stdInitParams);
	await client.newSession();

	await expect(client.model()).resolves.toBe(modelA.id);
	await expect(client.model(modelB.id)).resolves.toBe(modelB.id);
	await expect(client.model()).resolves.toBe(modelB.id);
});

test("BodhiPiClient requires an active session for session-scoped methods", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = createBodhiPiClient(harness.clientConn, { cwd: "/proj" });

	await client.initialize(stdInitParams);
	expect(() => client.models()).not.toThrow();
	await expect(client.model("gpt-5-mini")).rejects.toThrow(/active session/);
	expect(() => client.getSessionStats()).toThrow(/active session/);
});

test("BodhiPiClient wraps session extension methods", async () => {
	const model = getModel("openai", "gpt-5-mini");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = createBodhiPiClient(harness.clientConn, { cwd: "/proj" });

	await client.initialize(stdInitParams);
	await client.newSession();

	await expect(client.setSessionName({ name: "client-test" })).resolves.toEqual({ ok: true, name: "client-test" });

	const stats = await client.getSessionStats();
	expect(stats.name).toBe("client-test");
	expect(stats.leafId).toEqual(expect.any(String));

	const exported = await client.exportSession();
	expect(exported.format).toBe("jsonl");
	expect(exported.content).toContain('"type":"session"');
});
