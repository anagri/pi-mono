import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeToken } from "../../src/server/auth/token.js";
import { rpc, startTestServer, type TestServer } from "../helpers/test-server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_ROOT = path.resolve(here, "../../e2e/playwright/data/commands-echo");

describe("session/new returns availableCommands when project commands exist", () => {
	let ts: TestServer;

	beforeEach(async () => {
		ts = await startTestServer({ workspaceOverride: SCENARIO_ROOT });
	});

	afterEach(async () => {
		await ts.cleanup();
	});

	it("includes the echo project command in availableCommands", async () => {
		const tok = encodeToken({ id: 1, email: "alice@example.com" });
		const created = await rpc<{
			sessionId: string;
			availableCommands?: { name: string }[];
		}>(ts.url, tok, {
			method: "session/new",
			params: { cwd: ts.dataDir, mcpServers: [] },
		});
		expect(created.result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		const names = (created.result.availableCommands ?? []).map((c) => c.name);
		expect(names).toContain("echo");
	});
});
