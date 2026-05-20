// adapted from packages/bodhi-pi-browser/src/runtime/bootstrap-worker.ts —
// main thread mounts the InMemory ZenFS before posting init; the worker just
// uses `cwd` directly. Extends InitMessage with e2e fields (models /
// defaultModelId / apiKeys / homeDir) so the harness can drive provider
// selection per test. Conditionally swaps in sandboxed adapter variants when
// init carries a `sandboxPort` (test-app-chrome-ext under MV3 CSP); without
// it (test-app-browser), uses direct AsyncFunction variants.

/// <reference lib="webworker" />
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import {
	type BodhiPiEvent,
	type BodhiPiEventHandlers,
	createInProcessMcpConnectionProvider,
	MCP_PREFIX,
	parseMcpServerEntry,
} from "@bodhiapp/bodhi-pi";
import { createBodhiPiHostAgent } from "@bodhiapp/bodhi-pi-test-app-utils/host-agent";
import { createJustBashTerminal } from "@bodhiapp/bodhi-pi-test-app-utils/just-bash-terminal";
import { createMessagePortStream } from "@bodhiapp/bodhi-pi-test-app-utils/message-port-stream";
import type {
	FsQueryMessage,
	FsReplyMessage,
	InitMessage,
	WorkerErrorMessage,
	WorkerEventMessage,
	WorkerReadyMessage,
	WorkerWireMessage,
} from "@bodhiapp/bodhi-pi-test-app-utils/worker-message-types";
import { configure, InMemory, fs as zenFs, mount as zenMount } from "@zenfs/core";
import { Bash } from "just-bash/browser";
import { createBrowserExtensionLoader } from "../extensions/browser-extension-loader.js";
import { createSandboxedBrowserExtensionLoader } from "../extensions/sandboxed-browser-extension-loader.js";
import { createZenfsFilesystem } from "../filesystem/zenfs-filesystem.js";
import { createDexieKvStore } from "../kv/dexie-kv-store.js";
import { createSandboxBridge } from "../sandbox/sandbox-bridge.js";
import { createBrowserScriptExecutor } from "../script-executor/browser-script-executor.js";
import { createSandboxedBrowserScriptExecutor } from "../script-executor/sandboxed-browser-script-executor.js";
import { createDexieSessionStore } from "../sessions/dexie-session-store.js";
import { tapReadable, tapWritable } from "./wire-tap.js";

declare const self: DedicatedWorkerGlobalScope;

function eventForwardingHandlers(): BodhiPiEventHandlers {
	const post = (event: BodhiPiEvent): undefined => {
		const record = event as unknown as WorkerEventMessage["record"];
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
		subagent_start: [post],
		subagent_end: [post],
		tool_blocked: [post],
		tool_approval_request: [post],
		tool_approval_response: [post],
	};
}

async function restoreConnectedMcps(
	kvStore: ReturnType<typeof createDexieKvStore>,
	provider: ReturnType<typeof createInProcessMcpConnectionProvider>,
): Promise<void> {
	let rows: Awaited<ReturnType<typeof kvStore.list>>;
	try {
		rows = await kvStore.list(MCP_PREFIX);
	} catch (err) {
		console.error("[bodhi-pi browser-adapter worker] mcp restore kv.list failed:", err);
		return;
	}
	for (const row of rows) {
		const entry = parseMcpServerEntry(row.value);
		if (!entry || entry.lastKnownStatus !== "connected") continue;
		const slug = row.key.slice(MCP_PREFIX.length);
		try {
			await provider.connect(slug, entry);
		} catch (err) {
			console.error(`[bodhi-pi browser-adapter worker] mcp restore failed for ${slug}:`, err);
		}
	}
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

async function mountSeedWorkspace(
	mountName: string,
	rootPath: string,
	seedFiles: Record<string, string>,
): Promise<void> {
	await configure({ mounts: {} });
	zenMount(rootPath, InMemory.create({ label: mountName }));
	// Ensure the mount root itself exists as a directory so subsequent
	// reads / list / stat against the root succeed even with no seed files.
	try {
		await zenFs.promises.mkdir(rootPath, { recursive: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	for (const rel of Object.keys(seedFiles).sort()) {
		const abs = rel.startsWith("/") ? `${rootPath}${rel}` : `${rootPath}/${rel}`;
		const slash = abs.lastIndexOf("/");
		if (slash > rootPath.length) {
			try {
				await zenFs.promises.mkdir(abs.slice(0, slash), { recursive: true });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			}
		}
		await zenFs.promises.writeFile(abs, seedFiles[rel] ?? "", { encoding: "utf-8" });
	}
}

function registerFsQueryHandler(): void {
	self.addEventListener("message", async (ev: MessageEvent<FsQueryMessage>) => {
		if (ev.data?.type !== "bodhi-pi-fs-query") return;
		const { id, op, path } = ev.data;
		try {
			if (op === "read") {
				const content = (await zenFs.promises.readFile(path, "utf-8")) as string;
				const reply: FsReplyMessage = { type: "bodhi-pi-fs-reply", id, ok: true, content };
				self.postMessage(reply);
			} else if (op === "exists") {
				let exists = true;
				try {
					await zenFs.promises.access(path);
				} catch {
					exists = false;
				}
				const reply: FsReplyMessage = { type: "bodhi-pi-fs-reply", id, ok: true, exists };
				self.postMessage(reply);
			}
		} catch (err) {
			const reply: FsReplyMessage = {
				type: "bodhi-pi-fs-reply",
				id,
				ok: false,
				error: (err as Error).message ?? String(err),
			};
			self.postMessage(reply);
		}
	});
}

export function bootstrapAgentWorker(): void {
	self.addEventListener("message", function onInit(ev: MessageEvent<InitMessage>) {
		if (ev.data?.type !== "init") return;
		self.removeEventListener("message", onInit);

		const {
			agentPort,
			cwd,
			dbName,
			mountName,
			seedFiles,
			models,
			defaultModelId,
			apiKeys,
			systemPrompt,
			appendSystemPrompt,
			homeDir,
			sandboxPort,
		} = ev.data;

		void (async () => {
			await mountSeedWorkspace(mountName, cwd, seedFiles);
			registerFsQueryHandler();
			const filesystem = createZenfsFilesystem();
			const sessionStore = createDexieSessionStore({ dbName: `${dbName}-sessions` });
			const kvStore = createDexieKvStore({ dbName: `${dbName}-kv` });
			const terminal = createJustBashTerminal(Bash, { filesystem, defaultCwd: cwd });
			const bridge = sandboxPort ? createSandboxBridge(sandboxPort) : undefined;
			const scriptExecutor = bridge
				? createSandboxedBrowserScriptExecutor({ filesystem, bridge })
				: createBrowserScriptExecutor({ filesystem });
			const extensionFactories = bridge
				? await createSandboxedBrowserExtensionLoader({ filesystem, cwd, bridge })
				: await createBrowserExtensionLoader({ filesystem, cwd });

			const getApiKey = apiKeys ? (provider: string) => apiKeys[provider] : undefined;

			// Worker-scoped MCP connection provider. Worker dies on page refresh,
			// so connections die too — but kv (Dexie/IndexedDB) survives, so we
			// auto-reconnect any entry with `lastKnownStatus === "connected"`
			// below. Restore is host policy; the SDK never auto-rehydrates.
			// `kvStore` is threaded so the oauth-preregistered attacher can re-read
			// the latest access token from kv per outbound request (refresh writes
			// new tokens back; next request picks them up automatically).
			const mcpConnectionProvider = createInProcessMcpConnectionProvider({ kvStore });

			const factory = createBodhiPiHostAgent(
				{ sessionStore, filesystem },
				{
					kvStore,
					scriptExecutor,
					terminal,
					supportsMcpStdio: false,
					mcpConnectionProvider,
					models: models && models.length > 0 ? models : undefined,
					defaultModelId,
					getApiKey,
					systemPrompt,
					appendSystemPrompt,
					homeDir,
					eventHandlers: eventForwardingHandlers(),
					extensionFactories: extensionFactories.length > 0 ? extensionFactories : undefined,
					// Per modes.md PoC defaults: every host opts into ad-hoc allow-all via /mode;
					// settings-side default remains gated to avoid an unsafe persistent default.
					allowsAllowAllMode: true,
					allowsAllowAllModeAsDefault: false,
				},
			);

			const { readable, writable } = createMessagePortStream(agentPort);
			const teedReadable = tapReadable(readable, (line) => postWireFrame("in", line));
			const teedWritable = tapWritable(writable, (line) => postWireFrame("out", line));
			const conn = new AgentSideConnection(factory, ndJsonStream(teedWritable, teedReadable));
			void conn;
			// Host-side MCP restore: kv (Dexie) survives page refresh, but the
			// worker's in-process connection map doesn't. Reconnect entries
			// whose lastKnownStatus is "connected" so prior MCP state is
			// transparently restored on reload.
			await restoreConnectedMcps(kvStore, mcpConnectionProvider);
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
