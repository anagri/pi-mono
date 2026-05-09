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
			let closed = false;
			const closeOnce = () => {
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					// already closed/errored — ignore
				}
			};

			port.onmessage = (event) => {
				if (closed) return;
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
				if (closed) return;
				controller.error(new Error(`MessagePort message error: ${String(event.data)}`));
			};
			// Node `worker_threads` MessagePort emits a `close` event when either
			// side closes; DOM `MessagePort` has no equivalent (no remote-close
			// signal) — silent reader hang remains a DOM-side gap. Either way,
			// once we settle on `close` we drain to `{done: true}` so a pending
			// `reader.read()` no longer wedges.
			const portWithEvents = port as unknown as {
				addEventListener?: (type: string, listener: (e?: unknown) => void) => void;
				on?: (event: string, listener: () => void) => void;
			};
			if (typeof portWithEvents.addEventListener === "function") {
				portWithEvents.addEventListener("close", closeOnce);
			} else if (typeof portWithEvents.on === "function") {
				portWithEvents.on("close", closeOnce);
			}
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
