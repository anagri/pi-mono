// Top-level barrel for the browser test-app's Client surface (React
// components + slash dispatcher). Transport types re-export from app-utils
// so chrome-ext and http frontend can import them via this single barrel
// (back-compat with the pre-split ui-lib/ui/index.ts shape).

import "./react/app-shell.css";

export { AppShell, type AppShellProps } from "./react/AppShell.tsx";
export {
	type ChatMessage,
	ChatPanel,
	type ChatPanelProps,
	type ChatPanelState,
	type ChatToolCall,
} from "./react/ChatPanel.tsx";
export {
	extractModelFromConfigOptions,
	isSlash,
	type SlashContext,
	type SlashOutcome,
	type SlashState,
	tryHandleSlash,
} from "./lib/commands.ts";
export { DevAcpIo, type DevAcpIoProps } from "./react/DevAcpIo.tsx";
export { ErrorBanner } from "./react/ErrorBanner.tsx";
export { EventsPanel, type EventsPanelProps } from "./react/EventsPanel.tsx";
export { SetupForm, type SetupFormProps } from "./react/SetupForm.tsx";
export { StatusBar, type StatusBarProps } from "./react/StatusBar.tsx";
export { WirePanel, type WirePanelProps } from "./react/WirePanel.tsx";

// Transport-related types now live in app-utils so all browser-runtime Hosts
// (http frontend, chrome-ext) can import the same shape without depending on
// browser's source.
export type {
	ConnectCallbacks,
	ConnectResult,
	EventEntry,
	FrameEntry,
	SetupFormValues,
	TransportAdapter,
} from "@bodhiapp/bodhi-pi-test-app-utils/transport-types";
