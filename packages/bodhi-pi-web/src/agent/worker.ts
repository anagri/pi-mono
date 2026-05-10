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
import type { InitMessage, WorkerEventMessage, WorkerWireMessage } from "./types";
import { tapReadable, tapWritable } from "./wire-tap";

declare const self: DedicatedWorkerGlobalScope;

function eventForwardingHandlers(): BodhiPiEventHandlers {
	// Returning `undefined` keeps `post` compatible with both observer hooks
	// and mutable hooks (`tool_call`, `tool_result`, `before_agent_start`).
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

function postWireFrame(direction: "in" | "out", line: string): void {
	const message: WorkerWireMessage = {
		type: "bodhi-pi-wire",
		direction,
		line,
		ts: Date.now(),
	};
	self.postMessage(message);
}

self.addEventListener("message", function onInit(ev: MessageEvent<InitMessage>) {
	if (ev.data?.type !== "init") return;
	self.removeEventListener("message", onInit);

	const { agentPort, models, defaultModelId, apiKeys, systemPrompt, workspace: workspaceData } = ev.data;

	void (async () => {
		const workspace = workspaceProviderFromData(workspaceData);
		await workspace.mount();

		const filesystem = createZenfsFilesystem();
		const sessionStore = createDexieSessionStore({ dbName: "bodhi-pi-web" });
		const scriptExecutor = createBrowserScriptExecutor({ filesystem });

		const extensionFactories = await createBrowserExtensionLoader({ filesystem, cwd: workspace.rootPath });

		const factory = createBodhiPiAgent({
			models,
			defaultModelId,
			getApiKey: (provider: string) => apiKeys[provider],
			filesystem,
			sessionStore,
			scriptExecutor,
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
			eventHandlers: eventForwardingHandlers(),
			...(extensionFactories.length > 0 ? { extensionFactories } : {}),
		});

		const { readable, writable } = createMessagePortStream(agentPort);
		const teedReadable = tapReadable(readable, (line) => postWireFrame("in", line));
		const teedWritable = tapWritable(writable, (line) => postWireFrame("out", line));
		const conn = new AgentSideConnection(factory, ndJsonStream(teedWritable, teedReadable));
		void conn;
	})().catch((err) => {
		console.error("[worker] boot failed:", err);
	});
});
