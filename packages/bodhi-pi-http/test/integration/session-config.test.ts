import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

describe("POST /acp — _bodhi-pi/session/config", () => {
	let workspace: string;
	let ts: TestServer;

	beforeEach(async () => {
		workspace = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-http-config-ws-"));
		// Seed AGENTS.md + project settings.json in the workspace cwd.
		writeFileSync(path.join(workspace, "AGENTS.md"), "http-config-codeword-OCTOPUS", "utf-8");
		const bodhiDir = path.join(workspace, ".bodhi-pi");
		mkdirSync(bodhiDir, { recursive: true });
		writeFileSync(
			path.join(bodhiDir, "settings.json"),
			JSON.stringify({ compaction: { reserveTokens: 31337 }, appendSystemPrompt: "HTTP-PROJECT-APPEND" }),
			"utf-8",
		);
		ts = await startTestServer({ workspaceOverride: workspace });
	});

	afterEach(async () => {
		await ts.cleanup();
		rmSync(workspace, { recursive: true, force: true });
	});

	it("returns resolved config: cwd, AGENTS.md, compaction overrides, appendSystemPrompt", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: workspace, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		const result = await rpc<{
			cwd: string;
			defaultModelId: string;
			currentModelId: string;
			compaction: { reserveTokens: number };
			appendSystemPrompt: string | null;
			contextFilePaths: string[];
		}>(ts.url, tok, {
			method: "_bodhi-pi/session/config",
			params: { sessionId },
		});

		expect(result.result.cwd).toBe(workspace);
		expect(result.result.compaction.reserveTokens).toBe(31337);
		expect(result.result.appendSystemPrompt).toBe("HTTP-PROJECT-APPEND");
		expect(result.result.contextFilePaths).toContain(path.join(workspace, "AGENTS.md"));
	});

	it("survives per-turn agent rebuild via rehydrate", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{ sessionId: string }>(ts.url, tok, {
			method: "session/new",
			params: { cwd: workspace, mcpServers: [] },
		});
		const sessionId = created.result.sessionId;

		// First call: fresh session.
		const r1 = await rpc<{ cwd: string }>(ts.url, tok, {
			method: "_bodhi-pi/session/config",
			params: { sessionId },
		});
		expect(r1.result.cwd).toBe(workspace);

		// Second call: a brand new HTTP request, agent is rebuilt; rehydrate path
		// must produce the same resolved config.
		const r2 = await rpc<{ cwd: string; contextFilePaths: string[] }>(ts.url, tok, {
			method: "_bodhi-pi/session/config",
			params: { sessionId },
		});
		expect(r2.result.cwd).toBe(workspace);
		expect(r2.result.contextFilePaths).toContain(path.join(workspace, "AGENTS.md"));
	});
});
