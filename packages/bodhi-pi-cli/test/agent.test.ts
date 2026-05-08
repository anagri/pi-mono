import fsNode from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createCliAgent } from "../src/agent.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { scriptToolThenDone } from "./helpers/faux-script.js";
import { createInProcessAcpPair } from "./helpers/in-process-connection.js";
import { chunkedAgentText } from "./helpers/notifications.js";
import { toolCallUpdates, toolUpdateText } from "./helpers/tool-call-asserts.js";

let tmpDir: string;
let dbPath: string;
let providers: FauxProviderRegistration[];

beforeEach(async () => {
	tmpDir = await fsNode.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-cli-agent-test-"));
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

function wireHarness(model: Model<Api>) {
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
	return { clientConn, updates, agent };
}

test("write tool creates a real file on disk", async () => {
	const faux = newFaux();
	const model = faux.getModel() as Model<Api>;
	scriptToolThenDone(faux, "write", { path: path.join(tmpDir, "out.txt"), content: "hello node" });

	const { clientConn } = wireHarness(model);
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: tmpDir, mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write it" }] });

	const content = await fsNode.readFile(path.join(tmpDir, "out.txt"), "utf-8");
	expect(content).toBe("hello node");
});

test("read tool reads a real file from disk", async () => {
	const seedPath = path.join(tmpDir, "seed.txt");
	await fsNode.writeFile(seedPath, "disk content", "utf-8");

	const faux = newFaux();
	const model = faux.getModel() as Model<Api>;
	scriptToolThenDone(faux, "read", { path: seedPath });

	const { clientConn, updates } = wireHarness(model);
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: tmpDir, mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read it" }] });

	const completed = toolCallUpdates(updates).filter((u) => u.status === "completed");
	expect(completed.length).toBeGreaterThanOrEqual(1);
	expect(toolUpdateText(completed[0])).toContain("disk content");
});

test("run_script spawns a real Node process", async () => {
	const scriptPath = path.join(tmpDir, "greet.js");
	await fsNode.writeFile(scriptPath, 'console.log("spawned: " + args[0]);', "utf-8");

	const faux = newFaux();
	const model = faux.getModel() as Model<Api>;
	scriptToolThenDone(faux, "run_script", { path: scriptPath, args: ["world"] });

	const { clientConn, updates } = wireHarness(model);
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: tmpDir, mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "run it" }] });

	const completed = toolCallUpdates(updates).filter((u) => u.status === "completed");
	expect(completed.length).toBeGreaterThanOrEqual(1);
	expect(toolUpdateText(completed[0])).toContain("spawned: world");
});

test("node filesystem jail blocks writes outside cwd", async () => {
	const faux = newFaux();
	const model = faux.getModel() as Model<Api>;
	scriptToolThenDone(faux, "write", { path: "/etc/hacked.txt", content: "oops" });

	const { clientConn, updates } = wireHarness(model);
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: tmpDir, mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write it" }] });

	const failed = toolCallUpdates(updates).filter((u) => u.status === "failed");
	expect(failed.length).toBeGreaterThanOrEqual(1);
});

test("SQLite db file is created on first session", async () => {
	const faux = newFaux();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([fauxAssistantMessage("acknowledged")]);

	const { clientConn } = wireHarness(model);
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: tmpDir, mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	await expect(fsNode.access(dbPath)).resolves.not.toThrow();
});

test("session history survives across two agent instances sharing the same dbPath", async () => {
	const faux1 = newFaux();
	const model1 = faux1.getModel() as Model<Api>;
	faux1.setResponses([fauxAssistantMessage("noted")]);

	const { clientConn: conn1 } = wireHarness(model1);
	await conn1.initialize(stdInitParams);
	const { sessionId } = await conn1.newSession({ cwd: tmpDir, mcpServers: [] });
	await conn1.prompt({ sessionId, prompt: [{ type: "text", text: "say noted" }] });

	// Second agent instance, same dbPath
	const faux2 = newFaux();
	const model2 = faux2.getModel() as Model<Api>;
	faux2.setResponses([fauxAssistantMessage("ack")]);

	const agent2 = createCliAgent({
		cwd: tmpDir,
		dbPath,
		models: [model2],
		defaultModelId: model2.id,
		getApiKey: () => "test-key",
	});
	const updates2: SessionNotification[] = [];
	const { clientConn: conn2 } = createInProcessAcpPair(agent2.factory, () => ({
		sessionUpdate: async (p) => {
			updates2.push(p);
		},
		requestPermission: async () => ({ outcome: { outcome: "approved" } }),
	}));
	await conn2.initialize(stdInitParams);
	await conn2.loadSession({ sessionId, cwd: tmpDir, mcpServers: [] });

	// History from agent1 replays as notifications
	expect(chunkedAgentText(updates2)).toContain("noted");
});
