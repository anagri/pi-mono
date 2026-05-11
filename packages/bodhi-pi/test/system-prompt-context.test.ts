import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedContextFile } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];
beforeEach(() => {
	providers = [];
});
afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function capturingFaux() {
	const faux = registerFauxProvider();
	providers.push(faux);
	const model = faux.getModel() as Model<Api>;
	const captured: Array<string | undefined> = [];
	faux.setResponses([
		(ctx: Context) => {
			captured.push(ctx.systemPrompt);
			return fauxAssistantMessage("ok");
		},
	]);
	return { model, captured };
}

test("AGENTS.md at cwd is concatenated into the prompt under # Project Context", async () => {
	const { model, captured } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	await seedContextFile(filesystem, "/proj", "AGENTS.md", "AGENTS-CODEWORD-ZEBRA");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	const sp = captured[0] ?? "";
	expect(sp).toContain("# Project Context");
	expect(sp).toContain("## /proj/AGENTS.md");
	expect(sp).toContain("AGENTS-CODEWORD-ZEBRA");
});

test("AGENTS.md walk: ancestor and cwd both injected, root-first ordering", async () => {
	const { model, captured } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	await seedContextFile(filesystem, "/", "AGENTS.md", "ROOT-INSTR");
	await seedContextFile(filesystem, "/proj", "AGENTS.md", "PROJ-INSTR");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	const sp = captured[0] ?? "";
	expect(sp).toContain("ROOT-INSTR");
	expect(sp).toContain("PROJ-INSTR");
	expect(sp.indexOf("ROOT-INSTR")).toBeLessThan(sp.indexOf("PROJ-INSTR"));
});

test("AGENTS.md beats CLAUDE.md within the same directory", async () => {
	const { model, captured } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	await seedContextFile(filesystem, "/proj", "AGENTS.md", "FROM-AGENTS-MD");
	await seedContextFile(filesystem, "/proj", "CLAUDE.md", "FROM-CLAUDE-MD");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	const sp = captured[0] ?? "";
	expect(sp).toContain("FROM-AGENTS-MD");
	expect(sp).not.toContain("FROM-CLAUDE-MD");
});

test("CLAUDE.md is used as fallback when AGENTS.md missing", async () => {
	const { model, captured } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	await seedContextFile(filesystem, "/proj", "CLAUDE.md", "CLAUDE-INSTRUCTION");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(captured[0]).toContain("CLAUDE-INSTRUCTION");
});
