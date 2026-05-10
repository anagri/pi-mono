import type { ServerResponse } from "node:http";

/**
 * Write SSE response headers. Must be called exactly once before any `writeSseEvent`.
 *
 * `X-Accel-Buffering: no` defeats nginx/CDN response buffering so chunks reach
 * the browser immediately rather than landing as one batched response.
 */
export function writeSseHeaders(res: ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
}

/**
 * Write one SSE event as `event: message\ndata: <JSON>\n\n`.
 *
 * JSON encoding handles embedded newlines/control chars; no extra escaping needed.
 */
export function writeSseEvent(res: ServerResponse, payload: unknown): void {
	const json = JSON.stringify(payload);
	res.write(`event: message\ndata: ${json}\n\n`);
}
