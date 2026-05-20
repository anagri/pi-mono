import type { Agent, Client, SessionNotification } from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { WebSocket } from "ws";
import { type BodhiPiAcpConnection, type BodhiPiEvent, LIFECYCLE_EVENT_METHOD } from "@/index.js";

const SUBPROTOCOL = "bodhi-pi.v1";

export interface WsConnectionOptions {
	baseUrl: string;
	token: string;
	onUpdate: (notif: SessionNotification) => void;
	/** Receives every `_bodhi-pi/lifecycle/event` notification frame. */
	onLifecycleEvent?: (ev: BodhiPiEvent) => void;
}

export interface WsConnectionHandle {
	conn: BodhiPiAcpConnection;
	close: () => Promise<void>;
}

/**
 * Open an ACP-over-WebSocket connection to test-app-http's `/acp-ws` endpoint.
 * Auth via `Sec-WebSocket-Protocol: [bodhi-pi.v1, bearer.<token>]`. The returned
 * `conn` is a `ClientSideConnection` typed as `BodhiPiAcpConnection`; the agent
 * stays alive for the lifetime of the WS (vs HTTP+SSE's per-turn rebuild).
 */
export async function openWsConnection(opts: WsConnectionOptions): Promise<WsConnectionHandle> {
	const url = `${opts.baseUrl.replace(/^http/, "ws")}/acp-ws`;
	const ws = new WebSocket(url, [SUBPROTOCOL, `bearer.${opts.token}`]);

	await new Promise<void>((resolve, reject) => {
		const onOpen = () => {
			ws.off("error", onError);
			resolve();
		};
		const onError = (err: Error) => {
			ws.off("open", onOpen);
			reject(err);
		};
		ws.once("open", onOpen);
		ws.once("error", onError);
	});

	const stream = wsToWebStream(ws);
	const acpStream = ndJsonStream(stream.writable, stream.readable);

	const onLifecycleEvent = opts.onLifecycleEvent;
	const client: Client = {
		sessionUpdate: async (params) => {
			opts.onUpdate(params);
		},
		requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }),
		extNotification: async (method, params) => {
			if (method === LIFECYCLE_EVENT_METHOD && onLifecycleEvent) {
				onLifecycleEvent(params as unknown as BodhiPiEvent);
			}
		},
	};

	const conn = new ClientSideConnection((_agent: Agent): Client => client, acpStream);

	return {
		conn: conn as unknown as BodhiPiAcpConnection,
		close: () =>
			new Promise<void>((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) {
					resolve();
					return;
				}
				ws.once("close", () => resolve());
				ws.close();
			}),
	};
}

function wsToWebStream(ws: WebSocket): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			ws.on("message", (data) => {
				try {
					controller.enqueue(toUint8Array(data));
				} catch (err) {
					controller.error(err);
				}
			});
			ws.on("close", () => {
				try {
					controller.close();
				} catch {
					// already closed
				}
			});
			ws.on("error", (err) => controller.error(err));
		},
		cancel() {
			ws.close();
		},
	});

	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise((resolve, reject) => {
				ws.send(chunk, (err) => (err ? reject(err) : resolve()));
			});
		},
		close() {
			ws.close();
		},
		abort(reason) {
			ws.close(1011, String(reason ?? ""));
		},
	});

	return { readable, writable };
}

function toUint8Array(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (Array.isArray(data)) {
		const buf = Buffer.concat(data as Buffer[]);
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (typeof data === "string") return new TextEncoder().encode(data);
	throw new Error(`unexpected ws message type: ${typeof data}`);
}
