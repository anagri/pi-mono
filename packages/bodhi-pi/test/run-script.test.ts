import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";
import { createTestScriptExecutor } from "./helpers/script-executor.js";
import { toolCallStarts, toolCallUpdates, toolUpdateText } from "./helpers/tool-call-asserts.js";

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

function modelOf(faux: FauxProviderRegistration): Model<Api> {
	return faux.getModel() as Model<Api>;
}

test("run_script tool is NOT registered when scriptExecutor is omitted", async () => {
	const faux = newProvider();
	let toolNames: string[] = [];
	faux.setResponses([
		(ctx: Context) => {
			toolNames = (ctx.tools ?? []).map((t) => t.name);
			return fauxAssistantMessage("ok");
		},
	]);
	const harness = createTestHarness({ models: [modelOf(faux)], defaultModelId: modelOf(faux).id });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(toolNames).not.toContain("run_script");
});

test("run_script tool IS registered when scriptExecutor is injected", async () => {
	const faux = newProvider();
	let toolNames: string[] = [];
	faux.setResponses([
		(ctx: Context) => {
			toolNames = (ctx.tools ?? []).map((t) => t.name);
			return fauxAssistantMessage("ok");
		},
	]);
	const filesystem = createInMemoryFilesystem();
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		scriptExecutor: createTestScriptExecutor(filesystem),
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(toolNames).toContain("run_script");
});

test("run_script invocation runs the script and emits tool_call/tool_call_update with kind=execute", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj/scripts", { recursive: true });
	await filesystem.writeTextFile("/proj/scripts/echo.js", "console.log('hello ' + args[0])");

	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("run_script", { path: "/proj/scripts/echo.js", args: ["bodhi"] })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);

	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		scriptExecutor: createTestScriptExecutor(filesystem),
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "run it" }] });

	const starts = toolCallStarts(harness.updates);
	const ends = toolCallUpdates(harness.updates);
	expect(starts).toHaveLength(1);
	expect(starts[0].kind).toBe("execute");
	expect(starts[0].rawInput).toMatchObject({ path: "/proj/scripts/echo.js", args: ["bodhi"] });
	expect(ends).toHaveLength(1);
	expect(ends[0].status).toBe("completed");
	expect(toolUpdateText(ends[0])).toContain("hello bodhi");
	expect(toolUpdateText(ends[0])).toContain("exitCode: 0");
});

test("missing script file surfaces as exit 1 in the tool result", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();

	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("run_script", { path: "/proj/missing.js" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);

	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		scriptExecutor: createTestScriptExecutor(filesystem),
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "run it" }] });

	const ends = toolCallUpdates(harness.updates);
	expect(ends).toHaveLength(1);
	expect(toolUpdateText(ends[0])).toContain("exitCode: 1");
});
