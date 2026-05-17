import type { WebSocket } from "ws";

export interface WsStream {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
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

export function wsToStream(ws: WebSocket): WsStream {
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
