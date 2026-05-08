/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent, createInMemoryFilesystem, createInMemorySessionStore } from "@bodhiapp/bodhi-pi";
import { createMessagePortStream } from "@bodhiapp/bodhi-pi-browser";
import type { InitMessage } from "./types";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", function onInit(ev: MessageEvent<InitMessage>) {
	if (ev.data?.type !== "init") return;
	self.removeEventListener("message", onInit);

	const { agentPort, models, defaultModelId, apiKeys, systemPrompt } = ev.data;

	const filesystem = createInMemoryFilesystem();
	const sessionStore = createInMemorySessionStore();

	const factory = createBodhiPiAgent({
		models,
		defaultModelId,
		getApiKey: (provider: string) => apiKeys[provider],
		filesystem,
		sessionStore,
		// scriptExecutor omitted in M3 — run_script skill stays unregistered.
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
	});

	const { readable, writable } = createMessagePortStream(agentPort);
	const conn = new AgentSideConnection(factory, ndJsonStream(writable, readable));
	void conn; // hold reference; the connection drives the agent's message loop.
});
