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
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";

// Extension-factory tests pass JS factory functions into the agent in-process.
// They can't translate over the cli stdio boundary, so they run under
// in-memory only. The cli runtime auto-loads extensions from disk via
// `.bodhi-pi/extensions/*.{js,mjs,cjs}` — a different surface, tested separately.

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test.runIf(isRuntime("in-memory"))("input-transform with real LLM: ?quick prefix produces a short answer", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
		extensionFactories: [asRegistered("input-transform", inputTransform)],
	});
	activeHarness = h;
	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	const result = await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "?quick what is 2 + 2" }],
	});

	expect(result.stopReason).toBe("end_turn");
	const text = chunkedAgentText(h.updates).trim();
	expect(text).toContain("4");
	expect(text.length).toBeLessThan(200);
});

test.runIf(isRuntime("in-memory"))("pirate with real LLM: response uses pirate-style language", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
		extensionFactories: [asRegistered("pirate", pirate)],
	});
	activeHarness = h;
	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "Say hello in your own words." }] });

	const text = chunkedAgentText(h.updates).toLowerCase();
	const piratey = ["arr", "matey", "ye", "ahoy", "yarr", "scallywag", "aye"];
	const hits = piratey.filter((w) => text.includes(w));
	expect(hits.length, `expected pirate vocabulary in: ${text}`).toBeGreaterThan(0);
});

test.runIf(isRuntime("in-memory"))(
	"redact-secrets with real LLM: API-key in tool output is scrubbed before being returned",
	async () => {
		const apiKey = requireEnv("OPENAI_API_KEY");
		const model = getModel("openai", "gpt-4o-mini");
		const h = await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: (p) => (p === "openai" ? apiKey : undefined),
			extensionFactories: [asRegistered("redact-secrets", redactSecrets)],
		});
		activeHarness = h;
		await h.filesystem.mkdir(`${h.cwd}/proj`, { recursive: true });
		await h.filesystem.writeTextFile(`${h.cwd}/proj/leak.txt`, "API_KEY=sk-PLAINTEXTSECRETXYZ123 should not leak");
		await h.clientConn.initialize(stdInitParams);
		const { sessionId } = await h.clientConn.newSession({ cwd: `${h.cwd}/proj`, mcpServers: [] });
		await h.clientConn.prompt({
			sessionId,
			prompt: [
				{
					type: "text",
					text: `Use the read tool on ${h.cwd}/proj/leak.txt and tell me what's there verbatim.`,
				},
			],
		});

		const completed = h.updates.find(
			(u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
		);
		const flat = JSON.stringify(completed);
		expect(flat).toContain("[REDACTED]");
		expect(flat).not.toContain("sk-PLAINTEXTSECRETXYZ123");
	},
);

test.runIf(isRuntime("in-memory"))("dynamic-tools with real LLM: model picks up bodhi_echo and uses it", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
		extensionFactories: [asRegistered("dynamic-tools", dynamicTools)],
	});
	activeHarness = h;
	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Call the bodhi_echo tool with the message 'integration-ok' and report what it returned.",
			},
		],
	});

	const calls = h.updates.filter((u) => u.update.sessionUpdate === "tool_call");
	const echoCall = calls.find((u) => JSON.stringify(u.update).includes("bodhi_echo"));
	expect(echoCall, "expected the LLM to call bodhi_echo").toBeDefined();
	const flat = JSON.stringify(h.updates);
	expect(flat).toContain("echoed: integration-ok");
});

test.runIf(isRuntime("in-memory"))(
	"registerProvider with real Anthropic: switching to extension-supplied model routes to Claude",
	async () => {
		const openaiKey = requireEnv("OPENAI_API_KEY");
		const anthropicKey = requireEnv("ANTHROPIC_API_KEY");
		const openai = getModel("openai", "gpt-4o-mini");
		const claude = getModel("anthropic", "claude-haiku-4-5");

		const h = await createE2EHarness({
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
		activeHarness = h;
		await h.clientConn.initialize(stdInitParams);
		const newSess = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
		const sid = newSess.sessionId;

		const opt = newSess.configOptions?.[0];
		if (!opt || opt.type !== "select") throw new Error("expected select option");
		const ids = (opt.options as Array<{ value: string }>).map((o) => o.value);
		expect(ids).toContain(claude.id);

		await h.clientConn.setSessionConfigOption({ sessionId: sid, configId: "model", value: claude.id });
		const result = await h.clientConn.prompt({
			sessionId: sid,
			prompt: [{ type: "text", text: "Reply with the single word: ping" }],
		});

		expect(result.stopReason).toBe("end_turn");
		expect(chunkedAgentText(h.updates).toLowerCase()).toContain("ping");
	},
);
