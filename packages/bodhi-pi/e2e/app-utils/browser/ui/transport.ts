import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { FrameEntry } from "../lib/frame-log.ts";
import type { SetupFormValues } from "./SetupForm.tsx";

export interface ConnectCallbacks {
	onFrame(f: Omit<FrameEntry, "seq">): void;
	onEvent(type: string, payload: string): void;
	onSessionUpdate(n: SessionNotification): void;
}

export interface ConnectResult {
	conn: ClientSideConnection;
	workspaceRoot: string;
	cwd: string;
}

export interface TransportAdapter {
	connect(values: SetupFormValues, callbacks: ConnectCallbacks): Promise<ConnectResult>;
	cleanup(): void | Promise<void>;
}
