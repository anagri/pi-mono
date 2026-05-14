// Minimal SSE-line parser for the test-app-http /acp stream. Reassembles
// `data:` lines into per-event JSON payloads. Mirrors the production parser at
// packages/bodhi-pi-http/src/frontend/lib/sse-parser.ts; the no-sibling-import
// rule (e2e/CLAUDE.md) forbids importing it directly. Update both copies in
// lockstep.

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
