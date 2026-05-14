import type {
	Client,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { encodeToken, type UserCtx } from "./auth.ts";
import { wsToStream } from "./ws-stream.ts";

export const SUBPROTOCOL = "bodhi-pi.v1";
export const LIFECYCLE_EVENT_METHOD = "_bodhi-pi/lifecycle/event";

export interface ClientHandlers {
	onSessionUpdate?: (n: SessionNotification) => void;
	onPermissionRequest?: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
	onExtNotification?: (method: string, params: Record<string, unknown>) => void;
}

class WireClient implements Client {
	private readonly handlers: ClientHandlers;
	constructor(handlers: ClientHandlers) {
		this.handlers = handlers;
	}
	async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		if (this.handlers.onPermissionRequest) return this.handlers.onPermissionRequest(params);
		const optionId = params.options[0]?.optionId;
		if (optionId) return { outcome: { outcome: "selected", optionId } };
		return { outcome: { outcome: "cancelled" } };
	}
	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.handlers.onSessionUpdate?.(params);
	}
	async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
		this.handlers.onExtNotification?.(method, params);
	}
}

export interface ConnectOptions {
	url: string;
	user?: UserCtx;
	handlers?: ClientHandlers;
	frameTap?: (direction: "in" | "out", raw: string) => void;
	onClose?: (ev: CloseEvent) => void;
}

export interface Connection {
	ws: WebSocket;
	conn: ClientSideConnection;
}

/**
 * Open an ACP-over-WebSocket connection to /acp-ws. Auth via
 * Sec-WebSocket-Protocol: [bodhi-pi.v1, bearer.<base64url-json>]. The returned
 * `conn` is a ClientSideConnection that drives the server-side agent.
 */
export function connect(opts: ConnectOptions): Promise<Connection> {
	const protocols = [SUBPROTOCOL];
	if (opts.user) protocols.push(`bearer.${encodeToken(opts.user)}`);
	const ws = new WebSocket(opts.url, protocols);
	ws.binaryType = "arraybuffer";

	return new Promise((resolve, reject) => {
		let opened = false;

		ws.addEventListener("open", () => {
			opened = true;
			const stream = wsToStream(ws, opts.frameTap);
			const acpStream = ndJsonStream(stream.writable, stream.readable);
			const conn = new ClientSideConnection(() => new WireClient(opts.handlers ?? {}), acpStream);
			resolve({ ws, conn });
		});

		ws.addEventListener("close", (ev) => {
			if (!opened) {
				reject(new Error(`connection closed before open (code=${ev.code})`));
				return;
			}
			opts.onClose?.(ev);
		});

		ws.addEventListener("error", () => {
			if (!opened) reject(new Error("websocket error before open"));
		});
	});
}
