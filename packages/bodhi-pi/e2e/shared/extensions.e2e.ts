import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

// Extension fixtures live as real files under `e2e/data/<slug>/.bodhi-pi/extensions/`
// and the harness materializes them per-runtime via `bodhiPiFixture`. Simple
// fixtures use flat `.js`; `register-provider` is a Node package with a
// `package.json` declaring `pi.extensions` — loaded by the rich extension
// loader. Phase 4 wires the rich loader for in-memory only; phase 5 widens to
// cli + http.

const harness = useHarness();

test("input-transform with real LLM: ?quick prefix produces a short answer", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
			bodhiPiFixture: "input-transform",
		}),
	);
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

test("pirate with real LLM: response uses pirate-style language", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
			bodhiPiFixture: "pirate",
		}),
	);
	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "Say hello in your own words." }] });

	const text = chunkedAgentText(h.updates).toLowerCase();
	const piratey = ["arr", "matey", "ye", "ahoy", "yarr", "scallywag", "aye"];
	const hits = piratey.filter((w) => text.includes(w));
	expect(hits.length, `expected pirate vocabulary in: ${text}`).toBeGreaterThan(0);
});

test("redact-secrets with real LLM: API-key in tool output is scrubbed before being returned", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
			bodhiPiFixture: "redact-secrets",
		}),
	);
	await h.setupFiles({
		"proj/leak.txt": "API_KEY=sk-PLAINTEXTSECRETXYZ123 should not leak",
	});
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
});

test("register-command extension: custom slash command expands and reaches the model", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
			bodhiPiFixture: "register-command",
		}),
	);
	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/ext-greet" }] });
	expect(chunkedAgentText(h.updates).toLowerCase()).toContain("hi");
});

test("dynamic-tools with real LLM: model picks up bodhi_echo and uses it", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
			bodhiPiFixture: "dynamic-tools",
		}),
	);
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

test("registerProvider with real Anthropic: switching to extension-supplied model routes to Claude", async () => {
	const openai = getModel("openai", "gpt-4o-mini");
	const claude = getModel("anthropic", "claude-haiku-4-5-20251001");

	const h = harness.set(
		await createE2EHarness({
			models: [openai],
			defaultModelId: openai.id,
			getApiKey: envKeysFor("openai"),
			bodhiPiFixture: "register-provider",
		}),
	);
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
});
