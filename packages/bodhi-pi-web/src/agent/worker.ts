/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import {
	createBrowserScriptExecutor,
	createDexieSessionStore,
	createMessagePortStream,
	createZenfsFilesystem,
	mountFsaHandle,
	mountInMemorySeed,
} from "@bodhiapp/bodhi-pi-browser";
import type { InitMessage } from "./types";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", function onInit(ev: MessageEvent<InitMessage>) {
	if (ev.data?.type !== "init") return;
	self.removeEventListener("message", onInit);

	const { agentPort, models, defaultModelId, apiKeys, systemPrompt, workspace } = ev.data;

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

		const factory = createBodhiPiAgent({
			models,
			defaultModelId,
			getApiKey: (provider: string) => apiKeys[provider],
			filesystem,
			sessionStore,
			scriptExecutor,
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
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
