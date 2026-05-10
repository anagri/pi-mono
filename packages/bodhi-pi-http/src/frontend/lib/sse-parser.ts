/**
 * Async iterator over a `text/event-stream` body.
 *
 * Each yielded value is a parsed JSON-RPC frame's `data:` payload (we expect
 * the server to JSON-encode every event's data; this matches `acp/sse.ts`).
 *
 * Lines beginning with `event:` are ignored — the server always emits
 * `event: message`, and reading the data field is sufficient to decode our
 * JSON-RPC frames.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (value) buffer += decoder.decode(value, { stream: !done });
			while (true) {
				const idx = buffer.indexOf("\n\n");
				if (idx === -1) break;
				const block = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const dataLines: string[] = [];
				for (const line of block.split("\n")) {
					if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
				}
				if (dataLines.length === 0) continue;
				yield JSON.parse(dataLines.join("\n")) as unknown;
			}
			if (done) {
				if (buffer.trim().length > 0) {
					// Trailing partial frame without terminating \n\n — best-effort flush.
					const dataLines: string[] = [];
					for (const line of buffer.split("\n")) {
						if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
					}
					if (dataLines.length > 0) yield JSON.parse(dataLines.join("\n")) as unknown;
				}
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
