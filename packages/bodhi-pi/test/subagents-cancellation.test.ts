import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedSubagent } from "./helpers/filesystem.js";
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

test("client.cancel mid-spawn lands status='cancelled' on the child session + parent tool result", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "slowpoke", "---\ndescription: slow extractor\n---\nYou are slow.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { agent: "slowpoke", task: "take your time" })], {
			stopReason: "toolUse",
		}),
		async () => {
			await sleep(1500);
			return fauxAssistantMessage("child finally finished");
		},
		fauxAssistantMessage("parent wraps up"),
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const promptPromise = harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "use the slowpoke subagent" }],
	});
	setTimeout(() => {
		void harness.clientConn.cancel({ sessionId });
	}, 200);
	await promptPromise;

	const children = await harness.sessionStore.list({
		parentSessionId: sessionId,
		includeSubagentChildren: true,
	});
	expect(children.sessions).toHaveLength(1);

	const childId = children.sessions[0].sessionId;
	const childRecord = await harness.sessionStore.load(childId);
	expect(childRecord).toBeDefined();
	const completeEntry = childRecord!.entries.find((e) => e.type === "subagent_complete");
	expect(completeEntry, "expected a subagent_complete entry on the child").toBeDefined();
	expect(completeEntry).toMatchObject({ type: "subagent_complete", status: "cancelled" });

	const parentRecord = await harness.sessionStore.load(sessionId);
	expect(parentRecord).toBeDefined();
	const toolResultBodies: string[] = [];
	for (const entry of parentRecord!.entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult") continue;
		for (const block of msg.content) {
			if (block && typeof block === "object" && "type" in block && block.type === "text") {
				toolResultBodies.push((block as { text: string }).text);
			}
		}
	}
	expect(
		toolResultBodies.some((t) => t.includes('status="cancelled"')),
		"expected parent tool_result body to mark cancelled",
	).toBe(true);
});
