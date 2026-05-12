import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeToken, type UserCtx } from "./token.js";

const BEARER_PREFIX = "Bearer ";

export function extractBearerToken(req: IncomingMessage): string | undefined {
	const raw = req.headers.authorization;
	if (typeof raw !== "string") return undefined;
	if (!raw.startsWith(BEARER_PREFIX)) return undefined;
	const tok = raw.slice(BEARER_PREFIX.length).trim();
	return tok.length > 0 ? tok : undefined;
}

export function authenticateRequest(req: IncomingMessage): UserCtx {
	const tok = extractBearerToken(req);
	if (!tok) throw new Error("missing or malformed Authorization: Bearer header");
	return decodeToken(tok);
}

export function reject401(res: ServerResponse, message = "Unauthorized"): void {
	const body = `${message}\n`;
	res.writeHead(401, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}
