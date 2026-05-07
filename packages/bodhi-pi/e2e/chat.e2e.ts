import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { expect, test } from "vitest";
import { createBodhiPiAgent } from "../src/index.js";
import { createInProcessAcpPair } from "../test/helpers/in-process-connection.js";

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

function requireEnv(name: string): string {
	const value = process.env[name];
	expect(value, `${name} must be set in e2e/.env.test to run e2e tests`).toBeTruthy();
	return value as string;
}

interface SingleModelHarness {
	stopReason: string;
	chunks: SessionNotification[];
	text: string;
}

async function runSingleTurn(opts: {
	model: Model<Api>;
	apiKey: string;
	provider: string;
	prompt: string;
}): Promise<SingleModelHarness> {
	const updates: SessionNotification[] = [];

	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: [opts.model],
			defaultModelId: opts.model.id,
			getApiKey: (p) => (p === opts.provider ? opts.apiKey : undefined),
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

	const { sessionId } = await clientConn.newSession({
		cwd: process.cwd(),
		mcpServers: [],
	});

	const result = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: opts.prompt }],
	});

	const chunks = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
	return {
		stopReason: result.stopReason,
		chunks,
		text: chunkedAgentText(updates),
	};
}

test("Anthropic Haiku replies with tuesday via ACP", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");

	const result = await runSingleTurn({
		model: getModel("anthropic", "claude-haiku-4-5"),
		apiKey,
		provider: "anthropic",
		prompt: "Answer in one word: what day comes after Monday?",
	});

	expect(result.stopReason).toBe("end_turn");
	expect(result.chunks.length).toBeGreaterThanOrEqual(1);
	expect(result.text.toLowerCase()).toContain("tuesday");
});

test("OpenAI gpt-5-mini replies with tuesday via ACP", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");

	const result = await runSingleTurn({
		model: getModel("openai", "gpt-5-mini"),
		apiKey,
		provider: "openai",
		prompt: "Answer in one word: what day comes after Monday?",
	});

	expect(result.stopReason).toBe("end_turn");
	expect(result.chunks.length).toBeGreaterThanOrEqual(1);
	expect(result.text.toLowerCase()).toContain("tuesday");
});

test("switching model mid-session changes provenance", async () => {
	const anthropicKey = requireEnv("ANTHROPIC_API_KEY");
	const openaiKey = requireEnv("OPENAI_API_KEY");

	const claude = getModel("anthropic", "claude-haiku-4-5");
	const gpt = getModel("openai", "gpt-5-mini");

	const updates: SessionNotification[] = [];

	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: [claude, gpt],
			defaultModelId: claude.id,
			getApiKey: (p) => {
				if (p === "anthropic") return anthropicKey;
				if (p === "openai") return openaiKey;
				return undefined;
			},
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
	expect(initialOption.currentValue).toBe(claude.id);
	expect(initialOption.options).toHaveLength(2);

	const provenancePrompt =
		"Are you made by Anthropic or by OpenAI? Answer with exactly one of those two words and nothing else.";

	// Turn 1: routed to Anthropic
	updates.length = 0;
	const claudeResult = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: provenancePrompt }],
	});
	expect(claudeResult.stopReason).toBe("end_turn");
	const claudeText = chunkedAgentText(updates).toLowerCase();
	expect(
		claudeText.includes("anthropic") || claudeText.includes("claude"),
		`expected anthropic provenance, got: ${JSON.stringify(claudeText)}`,
	).toBe(true);

	// Switch to OpenAI
	const switchResult = await clientConn.setSessionConfigOption({
		sessionId,
		configId: "model",
		value: gpt.id,
	});
	const switched = asSelectOption(switchResult.configOptions[0]);
	expect(switched.currentValue).toBe(gpt.id);

	// Turn 2: routed to OpenAI
	updates.length = 0;
	const gptResult = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: provenancePrompt }],
	});
	expect(gptResult.stopReason).toBe("end_turn");
	const gptText = chunkedAgentText(updates).toLowerCase();
	expect(
		gptText.includes("openai") || gptText.includes("gpt") || gptText.includes("chatgpt"),
		`expected openai provenance, got: ${JSON.stringify(gptText)}`,
	).toBe(true);
});
