import fsNode from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
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
	tmpDir = await fsNode.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-cli-commands-test-"));
	dbPath = path.join(tmpDir, "sessions.db");
	providers = [];
});

afterEach(async () => {
	for (const p of providers) p.unregister();
	await fsNode.rm(tmpDir, { recursive: true, force: true });
});

function newFaux(): FauxProviderRegistration {
	const p = registerFauxProvider();
	providers.push(p);
	return p;
}

async function setup() {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("ok")]);
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
	const { sessionId } = await clientConn.newSession({ cwd: tmpDir, mcpServers: [] });

	const state: ReplState = {
		sessionId,
		currentModelId: model.id,
		defaultModelId: model.id,
		models: [model],
		availableCommands: [],
		closed: false,
	};

	return { clientConn, agent, state, model, updates, faux };
}

function makeCtx(clientConn: ClientSideConnection, state: ReplState, agent: { sessionStore: unknown }) {
	const renderer = createRenderer();
	return {
		clientConn,
		state,
		sessionStore: agent.sessionStore as never,
		renderer,
		cwd: tmpDir,
	};
}

test("/close marks state.closed; subsequent /sessions still lists the persisted session", async () => {
	const { clientConn, state, agent } = await setup();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/close", makeCtx(clientConn, state, agent));

	expect(state.closed).toBe(true);
	const closedLine = writeSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("closed session"));
	expect(closedLine, "stdout should announce the closed session").toBeDefined();

	writeSpy.mockClear();
	await handleCommand("/sessions", makeCtx(clientConn, state, agent));
	const sessionsOut = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(sessionsOut).toContain(state.sessionId.slice(0, 8));

	writeSpy.mockRestore();
});

test("/new after /close clears closed flag and creates a fresh session", async () => {
	const { clientConn, state, agent } = await setup();
	const oldSessionId = state.sessionId;
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/close", makeCtx(clientConn, state, agent));
	expect(state.closed).toBe(true);

	await handleCommand("/new", makeCtx(clientConn, state, agent));
	expect(state.closed).toBe(false);
	expect(state.sessionId).not.toBe(oldSessionId);

	writeSpy.mockRestore();
});

test("/delete <id> removes a non-active session and leaves active session intact", async () => {
	const { clientConn, state, agent } = await setup();
	const activeId = state.sessionId;
	const { sessionId: otherId } = await clientConn.newSession({ cwd: tmpDir, mcpServers: [] });
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand(`/delete ${otherId}`, makeCtx(clientConn, state, agent));

	const deletedLine = writeSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("deleted session"));
	expect(deletedLine).toBeDefined();
	expect(state.sessionId).toBe(activeId);
	expect(state.closed).toBe(false);

	writeSpy.mockClear();
	await handleCommand("/sessions", makeCtx(clientConn, state, agent));
	const sessionsOut = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(sessionsOut).toContain(activeId.slice(0, 8));
	expect(sessionsOut).not.toContain(otherId.slice(0, 8));

	writeSpy.mockRestore();
});

test("/delete <active-id> removes the active session AND recurses into /new", async () => {
	const { clientConn, state, agent } = await setup();
	const oldSessionId = state.sessionId;
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand(`/delete ${oldSessionId}`, makeCtx(clientConn, state, agent));

	expect(state.sessionId).not.toBe(oldSessionId);
	expect(state.closed).toBe(false);

	const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(out).toContain("deleted session");
	expect(out).toContain("new session");

	writeSpy.mockRestore();
});

test("/delete with no id prints usage and does not throw", async () => {
	const { clientConn, state, agent } = await setup();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/delete", makeCtx(clientConn, state, agent));

	const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(out).toContain("usage: /delete");

	writeSpy.mockRestore();
});

test("/help lists /close and /delete in the local-commands block", async () => {
	const { clientConn, state, agent } = await setup();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/help", makeCtx(clientConn, state, agent));

	const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(out).toContain("/close");
	expect(out).toContain("/delete <id>");

	writeSpy.mockRestore();
});
