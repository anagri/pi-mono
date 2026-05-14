import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { EXT_SESSION_CONFIG } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedProjectSettings } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];
let lastOptions: Record<string, unknown> | undefined;

beforeEach(() => {
	providers = [];
	lastOptions = undefined;
});
afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newFaux(): Model<Api> {
	const faux = registerFauxProvider();
	providers.push(faux);
	faux.setResponses([
		(_ctx, options) => {
			lastOptions = options as unknown as Record<string, unknown>;
			return fauxAssistantMessage("ok");
		},
	]);
	return faux.getModel() as Model<Api>;
}

test("maxRetryDelayMs from providerOptions threads to stream call", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	await seedProjectSettings(
		filesystem,
		"/proj",
		JSON.stringify({ providerOptions: { [model.provider]: { maxRetryDelayMs: 5000 } } }),
	);
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	expect(lastOptions?.maxRetryDelayMs).toBe(5000);
});

test("defaults from retry.maxDelayMs apply when providerOptions omits provider", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	await seedProjectSettings(
		filesystem,
		"/proj",
		JSON.stringify({
			retry: { maxDelayMs: 1000 },
			providerOptions: { anthropic: { maxRetryDelayMs: 9000 } },
		}),
	);
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	expect(lastOptions?.maxRetryDelayMs).toBe(1000);
});

test("_bodhi-pi/session/config surfaces resolved retry options", async () => {
	const model = newFaux();
	const filesystem = createInMemoryFilesystem();
	await seedProjectSettings(
		filesystem,
		"/proj",
		JSON.stringify({ providerOptions: { [model.provider]: { maxRetries: 9, timeoutMs: 4242 } } }),
	);
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SESSION_CONFIG, { sessionId })) as {
		retryOptions: { maxRetries?: number; timeoutMs?: number; maxRetryDelayMs?: number };
	};
	expect(result.retryOptions.maxRetries).toBe(9);
	expect(result.retryOptions.timeoutMs).toBe(4242);
});
