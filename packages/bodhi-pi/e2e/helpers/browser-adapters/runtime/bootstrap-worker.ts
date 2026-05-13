// adapted from packages/bodhi-pi-browser/src/runtime/bootstrap-worker.ts —
// drops sandboxPort + workspaceProviderFromData (the main thread mounts the
// InMemory ZenFS before posting init; the worker just uses `cwd` directly);
// extends InitMessage with e2e fields (models / defaultModelId / apiKeys /
// homeDir) so the harness can drive provider selection per test.

/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, type BodhiPiEventHandlers, createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import { createBrowserExtensionLoader } from "../extensions/browser-extension-loader.js";
import { createZenfsFilesystem } from "../filesystem/zenfs-filesystem.js";
import { createDexieKvStore } from "../kv/dexie-kv-store.js";
import { createBrowserScriptExecutor } from "../script-executor/browser-script-executor.js";
import { createDexieSessionStore } from "../sessions/dexie-session-store.js";
import { createMessagePortStream } from "../transport/message-port-stream.js";
import type {
	InitMessage,
	WorkerErrorMessage,
	WorkerEventMessage,
	WorkerReadyMessage,
	WorkerWireMessage,
} from "./types.js";
import { tapReadable, tapWritable } from "./wire-tap.js";

declare const self: DedicatedWorkerGlobalScope;

function eventForwardingHandlers(): BodhiPiEventHandlers {
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

export function bootstrapAgentWorker(): void {
	self.addEventListener("message", function onInit(ev: MessageEvent<InitMessage>) {
		if (ev.data?.type !== "init") return;
		self.removeEventListener("message", onInit);

		const { agentPort, cwd, dbName, models, defaultModelId, apiKeys, systemPrompt, appendSystemPrompt, homeDir } =
			ev.data;

		void (async () => {
			const filesystem = createZenfsFilesystem();
			const sessionStore = createDexieSessionStore({ dbName: `${dbName}-sessions` });
			const kvStore = createDexieKvStore({ dbName: `${dbName}-kv` });
			const scriptExecutor = createBrowserScriptExecutor({ filesystem });
			const extensionFactories = await createBrowserExtensionLoader({ filesystem, cwd });

			const getApiKey = apiKeys ? (provider: string) => apiKeys[provider] : undefined;

			const factory = createBodhiPiAgent({
				filesystem,
				sessionStore,
				kvStore,
				scriptExecutor,
				...(models && models.length > 0 ? { models } : {}),
				...(defaultModelId !== undefined ? { defaultModelId } : {}),
				...(getApiKey ? { getApiKey } : {}),
				...(systemPrompt !== undefined ? { systemPrompt } : {}),
				...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
				...(homeDir !== undefined ? { homeDir } : {}),
				eventHandlers: eventForwardingHandlers(),
				...(extensionFactories.length > 0 ? { extensionFactories } : {}),
			});

			const { readable, writable } = createMessagePortStream(agentPort);
			const teedReadable = tapReadable(readable, (line) => postWireFrame("in", line));
			const teedWritable = tapWritable(writable, (line) => postWireFrame("out", line));
			const conn = new AgentSideConnection(factory, ndJsonStream(teedWritable, teedReadable));
			void conn;
			const ready: WorkerReadyMessage = { type: "bodhi-pi-ready" };
			self.postMessage(ready);
		})().catch((err) => {
			const message: WorkerErrorMessage = {
				type: "bodhi-pi-error",
				message: (err as Error).message ?? String(err),
			};
			self.postMessage(message);
			console.error("[bodhi-pi browser-adapter worker] boot failed:", err);
		});
	});
}
