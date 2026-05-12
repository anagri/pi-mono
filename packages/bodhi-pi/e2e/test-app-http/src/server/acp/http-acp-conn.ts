import type { AgentSideConnection } from "@agentclientprotocol/sdk";

/**
 * Minimal AgentSideConnection-shaped stub used by per-request agent dispatchers.
 *
 * bodhi-pi only ever calls `sessionUpdate` and (when event handlers are wired)
 * `extNotification`. We do NOT implement `requestPermission`, `readTextFile`,
 * `writeTextFile`, or `createTerminal` — bodhi-pi doesn't call these (see
 * DEVELOPMENT.md for the explicit noted-skips).
 *
 * For JSON ACP methods (initialize/newSession/listSessions/etc.), no notifications
 * are emitted, so the default `onNotification` no-op suffices. SSE methods
 * (`session/prompt`, `session/load`) construct a conn whose `onNotification`
 * forwards to an SSE writer — see `acp/sse.ts` once it exists.
 */
export interface HttpAcpConnOptions {
	/** Called for each `sessionUpdate` from the agent. Default: no-op. */
	onNotification?: (notification: unknown) => void;
	/** Called for each `extNotification`. Default: no-op. */
	onExtNotification?: (method: string, params: Record<string, unknown>) => void;
}

export type HttpAcpConn = AgentSideConnection;

export function createHttpAcpConn(opts: HttpAcpConnOptions = {}): HttpAcpConn {
	const onNotification = opts.onNotification ?? (() => {});
	const onExtNotification = opts.onExtNotification ?? (() => {});

	const stub = {
		async sessionUpdate(notification: unknown): Promise<void> {
			onNotification(notification);
		},
		async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
			onExtNotification(method, params);
		},
		async requestPermission(): Promise<never> {
			throw new Error(
				"HttpAcpConn.requestPermission: not supported (bodhi-pi-http does not advertise permission capability)",
			);
		},
		async readTextFile(): Promise<never> {
			throw new Error("HttpAcpConn.readTextFile: not supported (bodhi-pi uses host-injected Filesystem)");
		},
		async writeTextFile(): Promise<never> {
			throw new Error("HttpAcpConn.writeTextFile: not supported (bodhi-pi uses host-injected Filesystem)");
		},
		async createTerminal(): Promise<never> {
			throw new Error("HttpAcpConn.createTerminal: not supported");
		},
		async extMethod(): Promise<never> {
			throw new Error("HttpAcpConn.extMethod: agent→client extension calls not supported");
		},
	};

	return stub as unknown as HttpAcpConn;
}
