import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
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

test("built-in prompt: no host systemPrompt yields tool descriptions for all registered tools", async () => {
	const { model, captured } = capturingFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	const sp = captured[0];
	expect(sp).toBeDefined();
	expect(sp).toContain("Available tools:");
	expect(sp).toContain("- read:");
	expect(sp).toContain("- write:");
	expect(sp).toContain("- edit:");
	expect(sp).toContain("- ls:");
	expect(sp).toContain("- find:");
	expect(sp).toContain("- grep:");
	// run_script absent because no scriptExecutor was supplied
	expect(sp).not.toContain("- run_script:");
	expect(sp).toContain("Current working directory: /proj");
});

test("built-in prompt: run_script snippet present when scriptExecutor supplied", async () => {
	const { model, captured } = capturingFaux();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		scriptExecutor: {
			async execute() {
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		},
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(captured[0]).toContain("- run_script:");
});

test("custom systemPrompt: host text appears in prompt; tool descriptions are NOT injected", async () => {
	const { model, captured } = capturingFaux();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		systemPrompt: "HOST-BASE-PROMPT-XYZZY",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	const sp = captured[0];
	expect(sp).toContain("HOST-BASE-PROMPT-XYZZY");
	expect(sp).not.toContain("Available tools:");
	expect(sp).toContain("Current working directory: /proj");
});
