export interface WsStream {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}

async function toUint8Array(data: unknown): Promise<Uint8Array> {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (data instanceof Uint8Array) return data;
	if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	if (typeof data === "string") return new TextEncoder().encode(data);
	throw new Error(`unexpected ws message type: ${typeof data}`);
}

export function wsToStream(ws: WebSocket): WsStream {
	ws.binaryType = "arraybuffer";

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			ws.addEventListener("message", (ev) => {
				toUint8Array(ev.data).then(
					(chunk) => controller.enqueue(chunk),
					(err) => controller.error(err),
				);
			});
			ws.addEventListener("close", () => {
				try {
					controller.close();
				} catch {
					// already closed
				}
			});
			ws.addEventListener("error", () => {
				try {
					controller.error(new Error("websocket error"));
				} catch {
					// already errored
				}
			});
		},
		cancel() {
			ws.close();
		},
	});

	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			// Browser WebSocket.send requires ArrayBufferView<ArrayBuffer>; copy into a fresh ArrayBuffer
			// to avoid SharedArrayBuffer-backed views (which TS rejects).
			const copy = new Uint8Array(chunk.byteLength);
			copy.set(chunk);
			ws.send(copy);
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
