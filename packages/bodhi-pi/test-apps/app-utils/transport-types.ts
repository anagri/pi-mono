import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";

/**
 * User-supplied form values for connecting a browser-runtime Host (browser,
 * chrome-ext, http frontend). Each Reference Host's connect form binds these
 * fields to its own UI.
 */
export interface SetupFormValues {
	userId: string;
	userEmail: string;
	seed: string;
	configRaw: string;
}

/** Frame log row scraped by the e2e harness via `[data-testid="frame"]`. */
export interface FrameEntry {
	seq: number;
	direction: "out" | "in";
	kind: "request" | "response" | "notification";
	method: string;
	rpcId: string;
	payload: string;
}

/** Event log row scraped by the e2e harness via `[data-testid="event"]`. */
export interface EventEntry {
	seq: number;
	type: string;
	payload: string;
}

/** Callbacks invoked by a TransportAdapter as it brings up the connection. */
export interface ConnectCallbacks {
	onFrame(f: Omit<FrameEntry, "seq">): void;
	onEvent(type: string, payload: string): void;
	onSessionUpdate(n: SessionNotification): void;
}

/** Result of a successful TransportAdapter.connect(). */
export interface ConnectResult {
	conn: ClientSideConnection;
	workspaceRoot: string;
	cwd: string;
}

/**
 * Browser-side transport adapter contract. Each Reference Host with a
 * browser-runtime UI (browser, chrome-ext, http) implements its own
 * factory returning this shape; the Client UI accepts any conforming
 * implementation.
 */
export interface TransportAdapter {
	connect(values: SetupFormValues, callbacks: ConnectCallbacks): Promise<ConnectResult>;
	cleanup(): void | Promise<void>;
}
