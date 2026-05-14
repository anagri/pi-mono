import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { EXT_SESSION_TREE } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});

afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newProvider(): FauxProviderRegistration {
	const p = registerFauxProvider();
	providers.push(p);
	return p;
}

test("prepareNextTurn proactively compacts between turns when usage exceeds threshold", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/data.txt", "hello world");

	const baseModel = faux.getModel();
	const model = { ...baseModel, contextWindow: 200000 };

	// Trailing summaries absorb post-loop `checkAutoCompact` retries so the
	// faux queue doesn't run dry and pollute the session tree with errors.
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/data.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("## Goal\nrigged-summary"),
		fauxAssistantMessage("done"),
		fauxAssistantMessage("## Goal\nrigged-summary-2"),
		fauxAssistantMessage("## Goal\nrigged-summary-3"),
	]);

	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		// Tight headroom so faux's tiny estimated usage trips `shouldCompact`.
		compaction: { reserveTokens: 199900 },
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "go" }],
	});
	expect(result.stopReason).toBe("end_turn");

	const tree = (await harness.clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: { id: string; type: string; role?: string; preview?: string; isLeaf: boolean }[];
	};

	const compactionNodes = tree.nodes.filter((n) => n.type === "compaction");
	expect(compactionNodes.length).toBeGreaterThanOrEqual(1);

	// Discriminator: the post-loop `checkAutoCompact` path would place every
	// compaction AFTER the "done" assistant message; prepareNextTurn lands
	// at least one BEFORE.
	const compactionIdx = tree.nodes.findIndex((n) => n.type === "compaction");
	const doneIdx = tree.nodes.findIndex((n) => n.preview === "done");
	expect(doneIdx).toBeGreaterThanOrEqual(0);
	expect(compactionIdx).toBeGreaterThanOrEqual(0);
	expect(compactionIdx).toBeLessThan(doneIdx);
});

test("prepareNextTurn no-ops when usage stays under threshold", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });

	const baseModel = faux.getModel();
	const model = { ...baseModel, contextWindow: 200000 };

	faux.setResponses([fauxAssistantMessage("hello")]);

	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "go" }],
	});
	expect(result.stopReason).toBe("end_turn");

	const tree = (await harness.clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: { type: string }[];
	};
	expect(tree.nodes.filter((n) => n.type === "compaction").length).toBe(0);
	expect(faux.state.callCount).toBe(1);
});
