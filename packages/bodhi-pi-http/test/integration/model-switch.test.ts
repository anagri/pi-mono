import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

interface ConfigOptionEntry {
	id: string;
	currentValue: string;
	options?: { value: string; name?: string }[];
}

interface SetConfigResponse {
	configOptions: ConfigOptionEntry[];
}

describe("POST /acp — session/setSessionConfigOption (model switch)", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("switches the active model and returns updated configOptions", async () => {
		ts.faux.setResponses([fauxAssistantMessage("ok")]);
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		// Run a prompt to ensure the session is exercised.
		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "ping" }] },
		});

		// Pick the configured default model id back as the value to set.
		const fauxModelId = ts.faux.getModel().id;
		const switched = await rpc<SetConfigResponse>(ts.url, tok, {
			method: "session/setSessionConfigOption",
			params: { sessionId, configId: "model", value: fauxModelId },
		});
		expect(switched.result.configOptions).toBeDefined();
		const modelOption = switched.result.configOptions.find((c) => c.id === "model");
		expect(modelOption).toBeDefined();
		expect(modelOption?.currentValue).toBe(fauxModelId);
	});

	it("rejects an unknown model id with a JSON-RPC error", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});

		await expect(
			rpc(ts.url, tok, {
				method: "session/setSessionConfigOption",
				params: { sessionId: created.result.sessionId, configId: "model", value: "no-such-model" },
			}),
		).rejects.toThrow(/RPC error/);
	});
});
