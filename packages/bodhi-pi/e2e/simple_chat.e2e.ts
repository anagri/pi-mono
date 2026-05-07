import { getModel } from "@mariozechner/pi-ai";
import { expect, test } from "vitest";
import { createAgentSession } from "../src/index.js";

function lastAssistantText(agent: ReturnType<typeof createAgentSession>): string {
	const messages = agent.state.messages;
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return "";
	return last.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

test("Anthropic Haiku replies with tuesday", async () => {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set in e2e/.env.test to run e2e tests");

	const agent = createAgentSession({
		initialState: { model: getModel("anthropic", "claude-haiku-4-5") },
		getApiKey: (p) => (p === "anthropic" ? apiKey : undefined),
	});

	await agent.prompt("Answer in one word: what day comes after Monday?");
	await agent.waitForIdle();

	expect(lastAssistantText(agent).toLowerCase()).toContain("tuesday");
});

test("OpenAI gpt-5-mini replies with tuesday", async () => {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error("OPENAI_API_KEY must be set in e2e/.env.test to run e2e tests");

	const agent = createAgentSession({
		initialState: { model: getModel("openai", "gpt-5-mini") },
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
	});

	await agent.prompt("Answer in one word: what day comes after Monday?");
	await agent.waitForIdle();

	expect(lastAssistantText(agent).toLowerCase()).toContain("tuesday");
});
