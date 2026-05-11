import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("lifecycle event forwarding via SSE _bodhi-pi/lifecycle/event", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("emits a lifecycle event sequence during a faux prompt", async () => {
		ts.faux.setResponses([fauxAssistantMessage("ok")]);
		const tok = encodeToken({ id: 1, email: "alice@example.com" });

		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});

		const result = await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId: created.result.sessionId, prompt: [{ type: "text", text: "ping" }] },
		});

		const lifecycleTypes = result.notifications
			.filter((n) => n.method === "_bodhi-pi/lifecycle/event")
			.map((n) => (n.params as { type: string }).type);

		// Must include the canonical sequence for a basic text turn.
		expect(lifecycleTypes).toContain("agent_start");
		expect(lifecycleTypes).toContain("turn_start");
		expect(lifecycleTypes).toContain("turn_end");
		expect(lifecycleTypes).toContain("agent_end");
	});
});
