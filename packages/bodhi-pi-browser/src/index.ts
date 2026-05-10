// Adapter factories (pre-existing public API)

// Env helper (parameterized; host injects getEnvVar)
export { buildResolvedEnv, type ResolvedEnv } from "./env/env.js";
export {
	type BrowserExtensionLoaderOptions,
	createBrowserExtensionLoader,
} from "./extensions/browser-extension-loader.js";
export {
	createSandboxedBrowserExtensionLoader,
	type SandboxedExtensionLoaderOptions,
} from "./extensions/sandboxed-browser-extension-loader.js";
export {
	clearHandle,
	loadHandle,
	queryPermission,
	requestPermission,
	type StoredHandle,
	saveHandle,
} from "./filesystem/fsa-handle-store.js";
export { createZenfsFilesystem } from "./filesystem/zenfs-filesystem.js";
export { type MountResult, mountFsaHandle, unmountAt } from "./filesystem/zenfs-mount.js";
// Runtime — agent worker bootstrap + main-thread runtime + ACP wiring
export { type BootstrapAgentWorkerOptions, bootstrapAgentWorker } from "./runtime/bootstrap-worker.js";
export { dispatchNotification, type RenderActions } from "./runtime/render.js";
export { type AgentRuntime, type RuntimeOptions, startAgentRuntime } from "./runtime/runtime.js";
export { clearLastSessionId, readLastSessionId, writeLastSessionId } from "./runtime/session-storage.js";
export type { InitMessage, WorkerEventMessage, WorkerMessage, WorkerWireMessage } from "./runtime/types.js";
export { tapReadable, tapWritable } from "./runtime/wire-tap.js";
export {
	createSandboxBridge,
	type ExtensionLoadResult,
	type ExtensionRegistration,
	type SandboxBridge,
	type ScriptResult,
} from "./sandbox/sandbox-bridge.js";
export { createBrowserScriptExecutor } from "./script-executor/browser-script-executor.js";
export { createSandboxedBrowserScriptExecutor } from "./script-executor/sandboxed-browser-script-executor.js";
export { createDexieSessionStore, type DexieSessionStoreOptions } from "./sessions/dexie-session-store.js";

// Stores (zustand)
export {
	type ChatMessage,
	type ChatState,
	type ChatStatus,
	type MessageRole,
	type ToolCallEntry,
	type ToolCallStatus,
	useChatStore,
} from "./store/chatStore.js";
export {
	type LifecycleEventRow,
	parseWireFrame,
	useEventStore,
	type WireEventRow,
	type WireFrameKind,
} from "./store/eventStore.js";
export { createMessagePortStream, type PortByteStream } from "./transport/message-port-stream.js";
// React UI components
export { ChatPage } from "./ui/ChatPage.js";
export { Composer, type ComposerProps } from "./ui/Composer.js";
export {
	handleCommand,
	isCommand,
	type UiCommandContext,
	type UiCommandState,
} from "./ui/commands.js";
export { DirectoryGate, type DirectoryGateProps } from "./ui/DirectoryGate.js";
export { EventsPanel } from "./ui/EventsPanel.js";
export { MessageList } from "./ui/MessageList.js";
export { RuntimeProvider, type RuntimeProviderProps, useRuntime } from "./ui/RuntimeProvider.js";
export { StatusBar } from "./ui/StatusBar.js";
export { ToolCallCard } from "./ui/ToolCallCard.js";
// Workspace — bootstrap + provider abstraction
export {
	type BootstrapResult,
	bootstrapWorkspace,
	pickAndPersistDirectory,
	reGrantPermission,
} from "./workspace/bootstrap.js";
export {
	fsaWorkspaceProvider,
	seedWorkspaceProvider,
	type WorkspaceData,
	type WorkspaceProvider,
	workspaceProviderFromData,
} from "./workspace/provider.js";
