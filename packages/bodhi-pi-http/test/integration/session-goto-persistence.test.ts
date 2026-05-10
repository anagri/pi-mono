import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { ssePrompt } from "../helpers/sse-client.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — /goto persists across per-turn rebuild after F.2 leaf_id schema", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer();
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("navigate to first user msg → next prompt branches from there (verified via /entries)", async () => {
		ts.faux.setResponses([
			fauxAssistantMessage("first reply"),
			fauxAssistantMessage("second reply"),
			fauxAssistantMessage("branch reply"),
		]);

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

		const entriesResp = await rpc<{ entries: { id: string; role: string; preview: string }[] }>(ts.url, tok, {
			method: "_bodhi-pi/session/entries",
			params: { sessionId },
		});
		const userEntries = entriesResp.result.entries.filter((e) => e.role === "user");
		expect(userEntries.length).toBe(2);
		const firstUserId = userEntries[0].id;

		const nav = await rpc<{ leafId: string }>(ts.url, tok, {
			method: "_bodhi-pi/session/navigate",
			params: { sessionId, targetEntryId: firstUserId },
		});
		expect(nav.result.leafId).toBe(firstUserId);

		// Next prompt is a separate HTTP request → fresh agent → resumeSession reads
		// leaf_id from SQLite. Without F.2 persistence, the leaf would revert to the
		// last entry (second-turn assistant). After F.2 it stays at firstUserId.
		await ssePrompt(ts.url, tok, {
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text: "branch turn" }] },
		});

		const after = await rpc<{ entries: { id: string; role: string; preview: string }[] }>(ts.url, tok, {
			method: "_bodhi-pi/session/entries",
			params: { sessionId },
		});
		const previews = after.result.entries.map((e) => e.preview.toLowerCase());
		expect(previews.some((p) => p.includes("first"))).toBe(true);
		expect(previews.some((p) => p.includes("branch"))).toBe(true);
		expect(previews.some((p) => p.includes("second"))).toBe(false);
	});
});
