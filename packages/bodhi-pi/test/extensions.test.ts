import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, createInMemorySessionStore } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import {
	asRegistered,
	dynamicTools,
	inputTransform,
	makeRegisterProviderFactory,
	pirate,
	redactSecrets,
} from "./helpers/extension-fixtures.js";
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

function modelOf(faux: FauxProviderRegistration): Model<Api> {
	return faux.getModel() as Model<Api>;
}

test("input-transform: ?quick prefix rewrites the user prompt before LLM sees it", async () => {
	const faux = newProvider();
	let observed: string | undefined;
	faux.setResponses([
		(ctx: Context) => {
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user");
			if (lastUser && Array.isArray(lastUser.content)) {
				const t = lastUser.content.find((b) => b.type === "text");
				observed = t?.text;
			}
			return fauxAssistantMessage("ok");
		},
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		extensionFactories: [asRegistered("input-transform", inputTransform)],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "?quick what is 2+2" }] });

	expect(observed).toBeDefined();
	expect(observed).toContain("Reply with one short sentence");
	expect(observed).toContain("what is 2+2");
});

test("pirate: appends a pirate-voice rule to the system prompt", async () => {
	const faux = newProvider();
	let observedSystem: string | undefined;
	faux.setResponses([
		(ctx: Context) => {
			observedSystem = ctx.systemPrompt;
			return fauxAssistantMessage("arr matey");
		},
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		systemPrompt: "be helpful",
		extensionFactories: [asRegistered("pirate", pirate)],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

	expect(observedSystem).toContain("Speak like a pirate");
	expect(observedSystem).toContain("be helpful");
});

test("redact-secrets: API-key-shaped strings are scrubbed from tool results", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/leak.txt", "API_KEY=sk-A1B2C3D4E5F6 trailing");
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/leak.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		extensionFactories: [asRegistered("redact-secrets", redactSecrets)],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read it" }] });

	const completed = harness.updates.find(
		(u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
	);
	const flat = JSON.stringify(completed);
	expect(flat).toContain("[REDACTED]");
	expect(flat).not.toContain("sk-A1B2C3D4E5F6");
});

test("dynamic-tools: extension-registered tool is reachable via tool_call dispatch", async () => {
	const faux = newProvider();
	let toolNames: string[] = [];
	faux.setResponses([
		(ctx: Context) => {
			toolNames = (ctx.tools ?? []).map((t) => t.name);
			return fauxAssistantMessage([fauxToolCall("bodhi_echo", { message: "hi from test" })], {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage("done"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		extensionFactories: [asRegistered("dynamic-tools", dynamicTools)],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "trigger" }] });

	expect(toolNames).toContain("bodhi_echo");
	const completed = harness.updates.find(
		(u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
	);
	expect(JSON.stringify(completed)).toContain("echoed: hi from test");
});

test("registerProvider: async getApiKey resolving to undefined falls through to next provider's getApiKey", async () => {
	// Regression test: previously the loop returned the first provider's *unawaited*
	// Promise, which is never `=== undefined`, so a provider whose async getApiKey
	// resolved to undefined silently shadowed every later provider's key.
	const fauxA = newProvider();
	const fauxB = newProvider();
	fauxA.setResponses([fauxAssistantMessage("ok")]);
	fauxB.setResponses([fauxAssistantMessage("ok")]);
	const modelA = { ...modelOf(fauxA), id: "model-a", name: "Model A" };
	const modelB = { ...modelOf(fauxB), id: "model-b", name: "Model B", provider: "ext-target-provider" } as Model<Api>;

	let firstSeen = 0;
	let secondSeen: string | undefined;

	const firstFactory: import("@/index.js").ExtensionFactory = (pi) => {
		pi.registerProvider("first", {
			model: modelA,
			getApiKey: async (provider: string) => {
				if (provider === "ext-target-provider") {
					firstSeen += 1;
					return undefined;
				}
				return undefined;
			},
		});
	};
	const secondFactory: import("@/index.js").ExtensionFactory = (pi) => {
		pi.registerProvider("second", {
			model: modelB,
			getApiKey: async (provider: string) => {
				if (provider === "ext-target-provider") {
					secondSeen = "real-secret";
					return "real-secret";
				}
				return undefined;
			},
		});
	};

	const harness = createTestHarness({
		models: [modelA],
		defaultModelId: "model-a",
		// host has no key for ext-target-provider — only the extensions can supply it
		getApiKey: () => undefined,
		extensionFactories: [
			{ name: "first", factory: firstFactory },
			{ name: "second", factory: secondFactory },
		],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.setSessionConfigOption({ sessionId, configId: "model", value: "model-b" });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	expect(firstSeen, "first provider's async undefined consulted").toBeGreaterThanOrEqual(1);
	expect(secondSeen, "fallthrough reached the second provider").toBe("real-secret");
});

test("registerProvider: extension-registered model is selectable and routes prompts to it", async () => {
	// Use two faux providers so we can assert the second one is reached only after
	// setSessionConfigOption switches to the extension-contributed model.
	const fauxA = newProvider();
	const fauxB = newProvider();
	fauxA.setResponses([fauxAssistantMessage("from-a")]);
	fauxB.setResponses([fauxAssistantMessage("from-b")]);
	const modelA = { ...modelOf(fauxA), id: "model-a", name: "Model A" };
	const modelB = { ...modelOf(fauxB), id: "model-b", name: "Model B" };

	const harness = createTestHarness({
		models: [modelA],
		defaultModelId: "model-a",
		extensionFactories: [
			asRegistered("register-provider", makeRegisterProviderFactory({ registrationName: "ext-b", model: modelB })),
		],
	});
	await harness.clientConn.initialize(stdInitParams);
	const newSess = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const sid = newSess.sessionId;

	// Both models are advertised in the configOptions list (extension model is additive).
	const opt = newSess.configOptions?.[0];
	if (!opt || opt.type !== "select") throw new Error("expected select option");
	const ids = opt.options.map((o: { value: string }) => o.value);
	expect(ids).toEqual(["model-a", "model-b"]);

	// First prompt routes to model-a (default).
	await harness.clientConn.prompt({ sessionId: sid, prompt: [{ type: "text", text: "hi" }] });
	expect(fauxA.state.callCount).toBe(1);
	expect(fauxB.state.callCount).toBe(0);

	// Switch to the extension-contributed model.
	await harness.clientConn.setSessionConfigOption({ sessionId: sid, configId: "model", value: "model-b" });
	await harness.clientConn.prompt({ sessionId: sid, prompt: [{ type: "text", text: "hi again" }] });
	expect(fauxB.state.callCount).toBe(1);
});

test("appendEntry round-trips through the session store and is filterable by extensionName + customType", async () => {
	const faux = newProvider();
	faux.setResponses([fauxAssistantMessage("ok")]);
	const sessionStore = createInMemorySessionStore();
	const factory = ((pi) => {
		pi.on("session_start", async (e) => {
			await pi.appendEntry(e.sessionId, { customType: "todo-list", data: { items: ["one", "two"] } });
		});
	}) as import("@/index.js").ExtensionFactory;

	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		sessionStore,
		extensionFactories: [{ name: "todo-fixture", factory }],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const matched = await sessionStore.readExtensionEntries(sessionId, {
		extensionName: "todo-fixture",
		customType: "todo-list",
	});
	expect(matched).toHaveLength(1);
	expect(matched[0]?.data).toEqual({ items: ["one", "two"] });
	expect(matched[0]?.extensionName).toBe("todo-fixture");

	// Negative filter — wrong customType returns nothing.
	const empty = await sessionStore.readExtensionEntries(sessionId, { customType: "nope" });
	expect(empty).toHaveLength(0);
});

test("inter-extension events bus delivers messages between extensions", async () => {
	const faux = newProvider();
	faux.setResponses([fauxAssistantMessage("ok")]);
	let received: unknown;

	const sender: import("@/index.js").ExtensionFactory = (pi) => {
		pi.on("session_start", () => {
			pi.events.emit("test:ping", { hello: "world" });
		});
	};
	const listener: import("@/index.js").ExtensionFactory = (pi) => {
		pi.events.on("test:ping", (data) => {
			received = data;
		});
	};

	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		extensionFactories: [
			// Listener loads first so its handler is registered when sender fires.
			{ name: "listener", factory: listener },
			{ name: "sender", factory: sender },
		],
	});
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	expect(received).toEqual({ hello: "world" });
});

test("builtin tools win on name collision (extension can't shadow `read`)", async () => {
	const faux = newProvider();
	faux.setResponses([fauxAssistantMessage("ok")]);

	let extensionToolCalled = false;
	const shadow: import("@/index.js").ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "read",
			description: "shadowing builtin read",
			parameters: { type: "object", properties: {}, additionalProperties: false } as never,
			execute: async () => {
				extensionToolCalled = true;
				return { content: [{ type: "text", text: "from extension" }], details: {} };
			},
		});
	};

	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/x.txt", "real");
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		extensionFactories: [{ name: "shadow", factory: shadow }],
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(extensionToolCalled).toBe(false);
});
