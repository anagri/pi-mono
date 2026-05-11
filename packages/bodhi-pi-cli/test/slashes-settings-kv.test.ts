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
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createCliAgent } from "@/agent.js";
import { handleCommand, type ReplState } from "@/repl/commands.js";
import { createRenderer } from "@/repl/render.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createInProcessAcpPair } from "./helpers/in-process-connection.js";

let tmpDir: string;
let homeDir: string;
let dbPath: string;
let providers: FauxProviderRegistration[];

beforeEach(async () => {
	tmpDir = await fsNode.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-cli-slashes-test-"));
	homeDir = await fsNode.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-cli-home-"));
	dbPath = path.join(tmpDir, "sessions.db");
	providers = [];
});

afterEach(async () => {
	for (const p of providers) p.unregister();
	await fsNode.rm(tmpDir, { recursive: true, force: true });
	await fsNode.rm(homeDir, { recursive: true, force: true });
});

async function setup(opts: { homeDir?: string } = {}) {
	const faux = registerFauxProvider();
	providers.push(faux);
	faux.setResponses([fauxAssistantMessage("ok")]);
	const model = faux.getModel() as Model<Api>;

	const agent = createCliAgent({
		cwd: tmpDir,
		dbPath,
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => "test-key",
		...(opts.homeDir !== undefined
			? { homeDir: opts.homeDir, kvDir: path.join(opts.homeDir, "kv") }
			: { kvDir: path.join(tmpDir, "kv") }),
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

	return { clientConn, agent, state, model };
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

test("/settings set --project writes .bodhi-pi/settings.json", async () => {
	const { clientConn, state, agent } = await setup();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/settings set compaction.reserveTokens 9999 --project", makeCtx(clientConn, state, agent));

	const written = JSON.parse(await fsNode.readFile(path.join(tmpDir, ".bodhi-pi", "settings.json"), "utf8"));
	expect(written).toEqual({ compaction: { reserveTokens: 9999 } });
	const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(out).toContain("set compaction.reserveTokens (scope: project)");
	writeSpy.mockRestore();
});

test("/settings set --global writes ~/.bodhi-pi/settings.json", async () => {
	const { clientConn, state, agent } = await setup({ homeDir });
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/settings set defaultThinkingLevel medium --global", makeCtx(clientConn, state, agent));

	const written = JSON.parse(await fsNode.readFile(path.join(homeDir, ".bodhi-pi", "settings.json"), "utf8"));
	expect(written).toEqual({ defaultThinkingLevel: "medium" });
	writeSpy.mockRestore();
});

test("/settings set --global without homeDir surfaces an error", async () => {
	const { clientConn, state, agent } = await setup();
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/settings set foo bar --global", makeCtx(clientConn, state, agent));

	const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(out).toMatch(/--global scope not supported/);
	writeSpy.mockRestore();
});

test("/login + /logins + /logout round-trip persists across process via NodeKvStore", async () => {
	const { clientConn, state, agent } = await setup({ homeDir });
	const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

	await handleCommand("/login openai sk-XYZ", makeCtx(clientConn, state, agent));
	writeSpy.mockClear();
	await handleCommand("/logins", makeCtx(clientConn, state, agent));
	const list1 = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(list1).toMatch(/openai: \*\*\*/);

	writeSpy.mockClear();
	await handleCommand("/logout openai", makeCtx(clientConn, state, agent));
	await handleCommand("/logins", makeCtx(clientConn, state, agent));
	const list2 = writeSpy.mock.calls.map((c) => String(c[0])).join("");
	expect(list2).toContain("(no stored auth)");

	writeSpy.mockRestore();
});
