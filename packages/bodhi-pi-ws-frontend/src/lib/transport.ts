import type {
	Client,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { encodeToken, type UserCtx } from "./auth";
import { wsToStream } from "./ws-stream";

export const SUBPROTOCOL = "bodhi-pi.v1";

class NoopClient implements Client {
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		throw new Error("not implemented in M1");
	}
	async sessionUpdate(_params: SessionNotification): Promise<void> {
		// noop in M1
	}
}

export interface ConnectOptions {
	url: string;
	user?: UserCtx;
	onClose?: (ev: CloseEvent) => void;
}

export interface Connection {
	ws: WebSocket;
	conn: ClientSideConnection;
}

export function connect(opts: ConnectOptions): Promise<Connection> {
	const protocols = [SUBPROTOCOL];
	if (opts.user) {
		protocols.push(`bearer.${encodeToken(opts.user)}`);
	}
	const ws = new WebSocket(opts.url, protocols);
	ws.binaryType = "arraybuffer";

	return new Promise((resolve, reject) => {
		let opened = false;

		ws.addEventListener("open", () => {
			opened = true;
			const stream = wsToStream(ws);
			const acpStream = ndJsonStream(stream.writable, stream.readable);
			const conn = new ClientSideConnection(() => new NoopClient(), acpStream);
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
			if (!opened) {
				reject(new Error("websocket error before open"));
			}
		});
	});
}
