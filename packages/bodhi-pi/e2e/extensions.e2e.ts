import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { requireEnv } from "@test/helpers/env.js";
import {
	asRegistered,
	dynamicTools,
	inputTransform,
	makeRegisterProviderFactory,
	pirate,
	redactSecrets,
} from "@test/helpers/extension-fixtures.js";
import { createTestHarness } from "@test/helpers/harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";

test("input-transform with real LLM: ?quick prefix produces a short answer", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const { clientConn, updates } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
		extensionFactories: [asRegistered("input-transform", inputTransform)],
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	const result = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "?quick what is 2 + 2" }],
	});

	expect(result.stopReason).toBe("end_turn");
	const text = chunkedAgentText(updates).trim();
	expect(text).toContain("4");
	// The "one short sentence" rule keeps this under ~120 chars in practice.
	expect(text.length).toBeLessThan(200);
});

test("pirate with real LLM: response uses pirate-style language", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const { clientConn, updates } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
		extensionFactories: [asRegistered("pirate", pirate)],
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "Say hello in your own words." }] });

	const text = chunkedAgentText(updates).toLowerCase();
	const piratey = ["arr", "matey", "ye", "ahoy", "yarr", "scallywag", "aye"];
	const hits = piratey.filter((w) => text.includes(w));
	expect(hits.length, `expected pirate vocabulary in: ${text}`).toBeGreaterThan(0);
});

test("redact-secrets with real LLM: API-key in tool output is scrubbed before being returned", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/leak.txt", "API_KEY=sk-PLAINTEXTSECRETXYZ123 should not leak");

	const { clientConn, updates } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
		filesystem,
		extensionFactories: [asRegistered("redact-secrets", redactSecrets)],
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Use the read tool on /proj/leak.txt and tell me what's there verbatim." }],
	});

	// Check the tool output the agent received — it must be redacted.
	const completed = updates.find(
		(u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
	);
	const flat = JSON.stringify(completed);
	expect(flat).toContain("[REDACTED]");
	expect(flat).not.toContain("sk-PLAINTEXTSECRETXYZ123");
});

test("dynamic-tools with real LLM: model picks up bodhi_echo and uses it", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const { clientConn, updates } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
		extensionFactories: [asRegistered("dynamic-tools", dynamicTools)],
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	await clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Call the bodhi_echo tool with the message 'integration-ok' and report what it returned.",
			},
		],
	});

	const calls = updates.filter((u) => u.update.sessionUpdate === "tool_call");
	const echoCall = calls.find((u) => JSON.stringify(u.update).includes("bodhi_echo"));
	expect(echoCall, "expected the LLM to call bodhi_echo").toBeDefined();
	const flat = JSON.stringify(updates);
	expect(flat).toContain("echoed: integration-ok");
});

test("registerProvider with real Anthropic: switching to extension-supplied model routes to Claude", async () => {
	const openaiKey = requireEnv("OPENAI_API_KEY");
	const anthropicKey = requireEnv("ANTHROPIC_API_KEY");
	const openai = getModel("openai", "gpt-4o-mini");
	const claude = getModel("anthropic", "claude-haiku-4-5");

	const { clientConn, updates } = createTestHarness({
		models: [openai],
		defaultModelId: openai.id,
		getApiKey: (p) => (p === "openai" ? openaiKey : undefined),
		extensionFactories: [
			asRegistered(
				"register-provider",
				makeRegisterProviderFactory({
					registrationName: "ext-anthropic",
					model: claude,
					apiKey: anthropicKey,
				}),
			),
		],
	});
	await clientConn.initialize(stdInitParams);
	const newSess = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	const sid = newSess.sessionId;

	const opt = newSess.configOptions?.[0];
	if (!opt || opt.type !== "select") throw new Error("expected select option");
	const ids = opt.options.map((o: { value: string }) => o.value);
	expect(ids).toContain(claude.id);

	await clientConn.setSessionConfigOption({ sessionId: sid, configId: "model", value: claude.id });
	const result = await clientConn.prompt({
		sessionId: sid,
		prompt: [{ type: "text", text: "Reply with the single word: ping" }],
	});

	expect(result.stopReason).toBe("end_turn");
	expect(chunkedAgentText(updates).toLowerCase()).toContain("ping");
});
