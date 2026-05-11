import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — _bodhi-pi/session/tree (per-turn agent rebuild)", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("returns all entries on the session with a single leaf marker", async () => {
		ts.faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "first turn" }] },
		});
		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "second turn" }] },
		});

		const tree = await rpc<{
			leafId: string;
			nodes: { id: string; isLeaf: boolean; type: string }[];
		}>(ts.url, tok, {
			method: "_bodhi-pi/session/tree",
			params: { sessionId },
		});
		expect(tree.result.nodes.length).toBeGreaterThan(0);
		const leafNodes = tree.result.nodes.filter((n) => n.isLeaf);
		expect(leafNodes).toHaveLength(1);
		expect(leafNodes[0].id).toBe(tree.result.leafId);
	});

	it("rejects unknown sessionId", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		await expect(
			rpc(ts.url, tok, {
				method: "_bodhi-pi/session/tree",
				params: { sessionId: "missing" },
			}),
		).rejects.toThrow(/RPC error/);
	});
});
