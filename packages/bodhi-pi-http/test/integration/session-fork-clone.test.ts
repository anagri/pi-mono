import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — _bodhi-pi/session/fork + clone (per-turn agent rebuild)", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("fork before a user message produces a new session whose /entries excludes that turn", async () => {
		ts.faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "first user turn" }] },
		});
		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "second user turn" }] },
		});

		const entries = await rpc<{ entries: { id: string; role: string; preview: string }[] }>(ts.url, tok, {
			method: "_bodhi-pi/session/entries",
			params: { sessionId },
		});
		const userEntries = entries.result.entries.filter((e) => e.role === "user");
		expect(userEntries.length).toBe(2);
		const forkAt = userEntries[1];

		const fork = await rpc<{ newSessionId: string; selectedText?: string }>(ts.url, tok, {
			method: "_bodhi-pi/session/fork",
			params: { sessionId, entryId: forkAt.id, position: "before" },
		});
		expect(fork.result.selectedText).toContain("second user turn");

		const forkedEntries = await rpc<{ entries: { id: string; role: string }[] }>(ts.url, tok, {
			method: "_bodhi-pi/session/entries",
			params: { sessionId: fork.result.newSessionId },
		});
		expect(forkedEntries.result.entries.filter((e) => e.role === "user")).toHaveLength(1);
		expect(forkedEntries.result.entries.find((e) => e.id === forkAt.id)).toBeUndefined();
	});

	it("clone duplicates the full chain", async () => {
		ts.faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "hello" }] },
		});
		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "world" }] },
		});

		const orig = await rpc<{ entries: { id: string }[] }>(ts.url, tok, {
			method: "_bodhi-pi/session/entries",
			params: { sessionId },
		});

		const clone = await rpc<{ newSessionId: string }>(ts.url, tok, {
			method: "_bodhi-pi/session/clone",
			params: { sessionId },
		});

		const cloned = await rpc<{ entries: { id: string }[] }>(ts.url, tok, {
			method: "_bodhi-pi/session/entries",
			params: { sessionId: clone.result.newSessionId },
		});
		expect(cloned.result.entries.length).toBe(orig.result.entries.length);
	});

	it("fork rejects unknown sessionId or entryId", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		await expect(
			rpc(ts.url, tok, {
				method: "_bodhi-pi/session/fork",
				params: { sessionId: "missing", entryId: "x" },
			}),
		).rejects.toThrow(/RPC error/);
	});
});
