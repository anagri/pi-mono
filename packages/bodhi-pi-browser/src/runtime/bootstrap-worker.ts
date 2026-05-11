/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, type BodhiPiEventHandlers, createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import { createBrowserExtensionLoader } from "../extensions/browser-extension-loader";
import { createSandboxedBrowserExtensionLoader } from "../extensions/sandboxed-browser-extension-loader";
import { createZenfsFilesystem } from "../filesystem/zenfs-filesystem";
import { createDexieKvStore } from "../kv/dexie-kv-store";
import { createSandboxBridge } from "../sandbox/sandbox-bridge";
import { createBrowserScriptExecutor } from "../script-executor/browser-script-executor";
import { createSandboxedBrowserScriptExecutor } from "../script-executor/sandboxed-browser-script-executor";
import { createDexieSessionStore } from "../sessions/dexie-session-store";
import { createMessagePortStream } from "../transport/message-port-stream";
import { workspaceProviderFromData } from "../workspace/provider";
import type { InitMessage, WorkerEventMessage, WorkerWireMessage } from "./types";
import { tapReadable, tapWritable } from "./wire-tap";

declare const self: DedicatedWorkerGlobalScope;

export interface BootstrapAgentWorkerOptions {
	/**
	 * Dexie database name. IndexedDB is origin-scoped, so different hosts at
	 * different origins won't collide even with the same dbName. Default
	 * `"bodhi-pi"`. Hosts may override.
	 */
	dbName?: string;
}

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

/**
 * Registers the worker-side init listener. Each host's worker entry calls this
 * once. After the first `init` message arrives the worker spins up the bodhi-pi
 * agent against browser-targeted adapters and bridges the agent port via ACP
 * ndjson, with byte-level taps that forward every wire frame to the main thread
 * for the EventsPanel.
 */
export function bootstrapAgentWorker(options: BootstrapAgentWorkerOptions = {}): void {
	const dbName = options.dbName ?? "bodhi-pi";

	self.addEventListener("message", function onInit(ev: MessageEvent<InitMessage>) {
		if (ev.data?.type !== "init") return;
		self.removeEventListener("message", onInit);

		const { agentPort, systemPrompt, appendSystemPrompt, workspace: workspaceData, sandboxPort } = ev.data;

		void (async () => {
			const workspace = workspaceProviderFromData(workspaceData);
			await workspace.mount();

			const filesystem = createZenfsFilesystem();
			const sessionStore = createDexieSessionStore({ dbName });
			const kvStore = createDexieKvStore({ dbName: `${dbName}-kv` });

			const bridge = sandboxPort ? createSandboxBridge(sandboxPort) : undefined;
			const scriptExecutor = bridge
				? createSandboxedBrowserScriptExecutor({ filesystem, bridge })
				: createBrowserScriptExecutor({ filesystem });

			const extensionFactories = bridge
				? await createSandboxedBrowserExtensionLoader({ filesystem, cwd: workspace.rootPath, bridge })
				: await createBrowserExtensionLoader({ filesystem, cwd: workspace.rootPath });

			const factory = createBodhiPiAgent({
				filesystem,
				sessionStore,
				kvStore,
				scriptExecutor,
				...(systemPrompt !== undefined ? { systemPrompt } : {}),
				...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
				eventHandlers: eventForwardingHandlers(),
				...(extensionFactories.length > 0 ? { extensionFactories } : {}),
			});

			const { readable, writable } = createMessagePortStream(agentPort);
			const teedReadable = tapReadable(readable, (line) => postWireFrame("in", line));
			const teedWritable = tapWritable(writable, (line) => postWireFrame("out", line));
			const conn = new AgentSideConnection(factory, ndJsonStream(teedWritable, teedReadable));
			void conn;
		})().catch((err) => {
			console.error("[bodhi-pi-browser worker] boot failed:", err);
		});
	});
}
