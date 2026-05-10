type FrameSink = (line: string) => void;

function makeFrameSplitter(onFrame: FrameSink): {
	transform: (chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => void;
	flush: () => void;
} {
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	return {
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (line.trim()) onFrame(line);
				idx = buffer.indexOf("\n");
			}
			controller.enqueue(chunk);
		},
		flush() {
			buffer += decoder.decode();
			if (buffer.trim()) onFrame(buffer);
			buffer = "";
		},
	};
}

export function tapReadable(source: ReadableStream<Uint8Array>, onFrame: FrameSink): ReadableStream<Uint8Array> {
	const splitter = makeFrameSplitter(onFrame);
	const tap = new TransformStream<Uint8Array, Uint8Array>({
		transform: splitter.transform,
		flush: splitter.flush,
	});
	return source.pipeThrough(tap);
}

export function tapWritable(sink: WritableStream<Uint8Array>, onFrame: FrameSink): WritableStream<Uint8Array> {
	const splitter = makeFrameSplitter(onFrame);
	const tap = new TransformStream<Uint8Array, Uint8Array>({
		transform: splitter.transform,
		flush: splitter.flush,
	});
	tap.readable.pipeTo(sink).catch((err) => {
		console.error("[bodhi-pi-web wire-tap] forward pipe failed", err);
	});
	return tap.writable;
}
