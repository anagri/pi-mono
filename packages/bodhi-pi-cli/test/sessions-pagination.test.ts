import fsNode from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { type Api, type FauxProviderRegistration, type Model, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createCliAgent } from "@/agent.js";
import { handleCommand, type ReplState } from "@/repl/commands.js";
import { createRenderer } from "@/repl/render.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createInProcessAcpPair } from "./helpers/in-process-connection.js";

let tmpDir: string;
let dbPath: string;
let providers: FauxProviderRegistration[];

beforeEach(async () => {
	tmpDir = await fsNode.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-cli-pagination-test-"));
	dbPath = path.join(tmpDir, "sessions.db");
	providers = [];
});

afterEach(async () => {
	for (const p of providers) p.unregister();
	await fsNode.rm(tmpDir, { recursive: true, force: true });
});

test("/sessions paginates across cursor boundaries — all 60 sessions visible in stdout", async () => {
	const faux = registerFauxProvider();
	providers.push(faux);
	const model = faux.getModel() as Model<Api>;

	const agent = createCliAgent({
		cwd: tmpDir,
		dbPath,
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => "test-key",
	});
	const updates: SessionNotification[] = [];
	const { clientConn } = createInProcessAcpPair(agent.factory, () => ({
		sessionUpdate: async (p) => {
			updates.push(p);
		},
		requestPermission: async () => ({ outcome: { outcome: "approved" } }),
	}));
	await clientConn.initialize(stdInitParams);

	const sessionIds: string[] = [];
	for (let i = 0; i < 60; i++) {
		const { sessionId } = await clientConn.newSession({ cwd: tmpDir, mcpServers: [] });
		sessionIds.push(sessionId);
	}

	const state: ReplState = {
		sessionId: sessionIds[sessionIds.length - 1],
		currentModelId: model.id,
		defaultModelId: model.id,
		models: [model],
		availableCommands: [],
		closed: false,
	};
	const ctx = {
		clientConn,
		state,
		sessionStore: agent.sessionStore as never,
		renderer: createRenderer(),
		cwd: tmpDir,
	};

	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	await handleCommand("/sessions", ctx);
	const written = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	writeSpy.mockRestore();

	const printedIdPrefixes = new Set<string>();
	for (const id of sessionIds) {
		if (written.includes(id.slice(0, 8))) printedIdPrefixes.add(id.slice(0, 8));
	}
	expect(printedIdPrefixes.size).toBe(60);
	expect(written).toContain("*");
});
