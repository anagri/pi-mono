import { LLMock } from "@copilotkit/aimock";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
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

let mock: LLMock;

beforeEach(async () => {
	mock = new LLMock({ port: 0 });
	await mock.start();
});

afterEach(async () => {
	await mock.stop();
});

test("simple chat round-trips through aimock", async () => {
	mock.onMessage(/Monday/i, { content: "tuesday" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const agent = createAgentSession({
		initialState: { model: { ...baseModel, baseUrl: `${mock.url}/v1` } },
		getApiKey: () => "test-key",
	});

	await agent.prompt("Answer in one word: what day comes after Monday?");
	await agent.waitForIdle();

	expect(lastAssistantText(agent).trim().toLowerCase()).toBe("tuesday");
});
