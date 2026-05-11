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
import { seedProjectSettings } from "./helpers/filesystem.js";
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

test("appendSystemPrompt: appears after host base systemPrompt", async () => {
	const { model, captured } = capturingFaux();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		systemPrompt: "BASE-MARKER",
		appendSystemPrompt: "APPEND-MARKER",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	const sp = captured[0] ?? "";
	expect(sp).toContain("BASE-MARKER");
	expect(sp).toContain("APPEND-MARKER");
	expect(sp.indexOf("BASE-MARKER")).toBeLessThan(sp.indexOf("APPEND-MARKER"));
});

test("appendSystemPrompt: appears in built-in prompt when no custom prompt is set", async () => {
	const { model, captured } = capturingFaux();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		appendSystemPrompt: "APPEND-BUILTIN",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	const sp = captured[0] ?? "";
	expect(sp).toContain("Available tools:");
	expect(sp).toContain("APPEND-BUILTIN");
});

test("appendSystemPrompt: project settings supplies value when host omits it", async () => {
	const { model, captured } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	await seedProjectSettings(filesystem, "/proj", JSON.stringify({ appendSystemPrompt: "PROJECT-APPEND" }));
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(captured[0]).toContain("PROJECT-APPEND");
});

test("appendSystemPrompt: host-explicit beats project settings on collision", async () => {
	const { model, captured } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	await seedProjectSettings(filesystem, "/proj", JSON.stringify({ appendSystemPrompt: "PROJECT-APPEND" }));
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		appendSystemPrompt: "HOST-APPEND",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	const sp = captured[0] ?? "";
	expect(sp).toContain("HOST-APPEND");
	expect(sp).not.toContain("PROJECT-APPEND");
});
