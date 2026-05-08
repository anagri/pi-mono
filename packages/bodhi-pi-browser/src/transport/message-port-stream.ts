/**
 * Wraps a `MessagePort` into the `{ readable, writable }` shape ACP's
 * `ndJsonStream()` expects. Used on both worker and main-thread sides to bridge
 * an ACP `Stream` over a structured-clone postMessage channel.
 *
 * Frames are `Uint8Array` chunks; we transfer the underlying `ArrayBuffer` on
 * write to avoid copies. Strings and `ArrayBuffer` payloads are coerced to
 * `Uint8Array` on read so callers don't have to care which side encoded them.
 */

export interface PortByteStream {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}

export function createMessagePortStream(port: MessagePort): PortByteStream {
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			port.onmessage = (event) => {
				const data = event.data as unknown;
				if (data instanceof Uint8Array) {
					controller.enqueue(data);
				} else if (data instanceof ArrayBuffer) {
					controller.enqueue(new Uint8Array(data));
				} else if (typeof data === "string") {
					controller.enqueue(new TextEncoder().encode(data));
				}
			};
			port.onmessageerror = (event) => {
				controller.error(new Error(`MessagePort message error: ${String(event.data)}`));
			};
			port.start();
		},
	});

	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			const out = new Uint8Array(chunk.byteLength);
			out.set(chunk);
			port.postMessage(out, [out.buffer]);
		},
	});

	return { readable, writable };
}
