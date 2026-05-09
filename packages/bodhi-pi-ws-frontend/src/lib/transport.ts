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

export interface ClientHandlers {
	onSessionUpdate?: (n: SessionNotification) => void;
	onPermissionRequest?: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

class WireClient implements Client {
	private readonly handlers: ClientHandlers;
	constructor(handlers: ClientHandlers) {
		this.handlers = handlers;
	}
	async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		if (this.handlers.onPermissionRequest) return this.handlers.onPermissionRequest(params);
		// Auto-approve: pick the first option (typical "allow" / "always allow").
		const optionId = params.options[0]?.optionId;
		if (optionId) {
			return { outcome: { outcome: "selected", optionId } };
		}
		return { outcome: { outcome: "cancelled" } };
	}
	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.handlers.onSessionUpdate?.(params);
	}
}

export interface ConnectOptions {
	url: string;
	user?: UserCtx;
	handlers?: ClientHandlers;
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
			if (!opened) {
				reject(new Error("websocket error before open"));
			}
		});
	});
}
