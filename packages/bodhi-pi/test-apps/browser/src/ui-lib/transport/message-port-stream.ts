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
