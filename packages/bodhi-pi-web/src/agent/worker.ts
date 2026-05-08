/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, type BodhiPiEventHandlers, createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import {
	createBrowserExtensionLoader,
	createBrowserScriptExecutor,
	createDexieSessionStore,
	createMessagePortStream,
	createZenfsFilesystem,
	mountFsaHandle,
	mountInMemorySeed,
} from "@bodhiapp/bodhi-pi-browser";
import type { InitMessage, WorkerEventMessage } from "./types";

declare const self: DedicatedWorkerGlobalScope;

/** Build a handlers map that posts a small record of every event back to the main thread. */
function recordingHandlers(): BodhiPiEventHandlers {
	const post = (event: BodhiPiEvent): void => {
		const record: WorkerEventMessage["record"] = { type: event.type };
		if ("sessionId" in event) record.sessionId = event.sessionId;
		if (
			event.type === "tool_call" ||
			event.type === "tool_result" ||
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_end"
		) {
			record.toolName = event.toolName;
		}
		if (event.type === "agent_start") record.userPrompt = event.userPrompt;
		if (event.type === "agent_end" && event.stopReason !== undefined) record.stopReason = event.stopReason;
		if (event.type === "model_select") {
			record.fromModelId = event.fromModelId;
			record.toModelId = event.toModelId;
		}
		const message: WorkerEventMessage = { type: "bodhi-pi-event", record };
		self.postMessage(message);
	};
	return {
		session_start: [post],
		session_shutdown: [post],
		agent_start: [post],
		agent_end: [post],
		turn_start: [post],
		turn_end: [post],
		message_start: [post],
		message_end: [post],
		tool_execution_start: [post],
		tool_execution_end: [post],
		input: [post],
		before_agent_start: [post],
		before_provider_request: [post],
		after_provider_response: [post],
		tool_call: [post],
		tool_result: [post],
		model_select: [post],
	};
}

self.addEventListener("message", function onInit(ev: MessageEvent<InitMessage>) {
	if (ev.data?.type !== "init") return;
	self.removeEventListener("message", onInit);

	const { agentPort, models, defaultModelId, apiKeys, systemPrompt, workspace, recordEvents } = ev.data;

	void (async () => {
		// Mount the granted folder (FSA) or the test seed (InMemory). bodhi-pi
		// receives a single `Filesystem` handle that routes through ZenFS.
		if (workspace.mode === "fsa") {
			await mountFsaHandle({ handle: workspace.handle, mountName: workspace.mountName });
		} else {
			await mountInMemorySeed({ mountName: workspace.mountName, files: workspace.seed.files });
		}
		const filesystem = createZenfsFilesystem();
		const sessionStore = createDexieSessionStore({ dbName: "bodhi-pi-web" });
		const scriptExecutor = createBrowserScriptExecutor({ filesystem });

		// Discover extensions from the mounted workspace's `.bodhi-pi/extensions/` dir.
		// JS-only here; TS-via-esbuild-wasm is deferred per the M5.2 plan.
		const cwd = workspace.mode === "fsa" ? `/mnt/${workspace.mountName}` : `/mnt/${workspace.mountName}`;
		const extensionFactories = await createBrowserExtensionLoader({ filesystem, cwd });

		const factory = createBodhiPiAgent({
			models,
			defaultModelId,
			getApiKey: (provider: string) => apiKeys[provider],
			filesystem,
			sessionStore,
			scriptExecutor,
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
			...(recordEvents ? { eventHandlers: recordingHandlers() } : {}),
			...(extensionFactories.length > 0 ? { extensionFactories } : {}),
		});

		const { readable, writable } = createMessagePortStream(agentPort);
		const conn = new AgentSideConnection(factory, ndJsonStream(writable, readable));
		void conn; // hold reference; the connection drives the agent's message loop.
	})().catch((err) => {
		// Surfacing as console.error makes the failure visible in dev tools and
		// the Playwright fixture's console capture.
		console.error("[worker] boot failed:", err);
	});
});
