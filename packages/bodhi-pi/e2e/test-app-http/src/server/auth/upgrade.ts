import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { decodeToken, type UserCtx } from "./token.js";

export const SUBPROTOCOL = "bodhi-pi.v1";
const BEARER_PREFIX = "bearer.";

export interface UpgradeContext {
	user: UserCtx;
}

export function parseSubprotocols(header: string | string[] | undefined): string[] {
	if (!header) return [];
	const raw = Array.isArray(header) ? header.join(",") : header;
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function extractBearer(protocols: string[]): string | undefined {
	const found = protocols.find((p) => p.startsWith(BEARER_PREFIX));
	return found?.slice(BEARER_PREFIX.length);
}

export function authenticateUpgrade(req: IncomingMessage): UpgradeContext {
	const protocols = parseSubprotocols(req.headers["sec-websocket-protocol"]);
	if (!protocols.includes(SUBPROTOCOL)) {
		throw new Error(`missing required subprotocol: ${SUBPROTOCOL}`);
	}
	const tokenRaw = extractBearer(protocols);
	if (!tokenRaw) {
		throw new Error("missing bearer.<token> subprotocol element");
	}
	const user = decodeToken(tokenRaw);
	return { user };
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
	const body = `${status} ${message}\n`;
	const headers = [
		`HTTP/1.1 ${status} ${message}`,
		"Connection: close",
		"Content-Type: text/plain; charset=utf-8",
		`Content-Length: ${Buffer.byteLength(body)}`,
		"",
		body,
	].join("\r\n");
	socket.write(headers);
	socket.destroy();
}

export function handleAgentUpgrade(
	wss: WebSocketServer,
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	onConnection: (ws: WebSocket, ctx: UpgradeContext) => void,
): void {
	let ctx: UpgradeContext;
	try {
		ctx = authenticateUpgrade(req);
	} catch {
		rejectUpgrade(socket, 401, "Unauthorized");
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		onConnection(ws, ctx);
	});
}
