/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, type BodhiPiEventHandlers, createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import {
	createBrowserExtensionLoader,
	createBrowserScriptExecutor,
	createDexieSessionStore,
	createMessagePortStream,
	createZenfsFilesystem,
} from "@bodhiapp/bodhi-pi-browser";
import { workspaceProviderFromData } from "../workspace/provider";
import type { InitMessage, WorkerEventMessage } from "./types";

declare const self: DedicatedWorkerGlobalScope;

/** Build a handlers map that posts a small record of every event back to the main thread. */
function recordingHandlers(): BodhiPiEventHandlers {
	// Returns `undefined` so the same handler is type-compatible with both pure
	// observers (e.g. `agent_start`) and mutable hooks (e.g. `tool_call`,
	// `tool_result`, `before_agent_start`) — `undefined` means "no override".
	const post = (event: BodhiPiEvent): undefined => {
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
		return undefined;
	};
	return {
		session_start: [post],
		session_shutdown: [post],
		agent_start: [post],
		agent_end: [post],
		turn_start: [post],
		turn_end: [post],
		message_start: [post],
		message_update: [post],
		message_end: [post],
		tool_execution_start: [post],
		tool_execution_update: [post],
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

	const { agentPort, models, defaultModelId, apiKeys, systemPrompt, workspace: workspaceData, recordEvents } = ev.data;

	void (async () => {
		// Reconstruct the provider on this side of the postMessage boundary, then
		// mount once. Downstream code never branches on FSA-vs-seed.
		const workspace = workspaceProviderFromData(workspaceData);
		await workspace.mount();

		const filesystem = createZenfsFilesystem();
		const sessionStore = createDexieSessionStore({ dbName: "bodhi-pi-web" });
		const scriptExecutor = createBrowserScriptExecutor({ filesystem });

		// Discover extensions from the mounted workspace's `.bodhi-pi/extensions/` dir.
		// JS-only here; TS-via-esbuild-wasm is deferred per the M5.2 plan.
		const extensionFactories = await createBrowserExtensionLoader({ filesystem, cwd: workspace.rootPath });

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
