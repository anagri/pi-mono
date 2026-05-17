import { describe, expect, it } from "vitest";
import { parseSse } from "./sse-parser.ts";

function streamFrom(text: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

function streamChunked(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[i]));
			i++;
		},
	});
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const v of parseSse(stream)) out.push(v);
	return out;
}

describe("parseSse", () => {
	it("parses a single complete frame", async () => {
		const text = `event: message\ndata: {"hello":"world"}\n\n`;
		expect(await collect(streamFrom(text))).toEqual([{ hello: "world" }]);
	});

	it("parses multiple frames in one buffer", async () => {
		const text = `event: message\ndata: {"a":1}\n\nevent: message\ndata: {"b":2}\n\n`;
		expect(await collect(streamFrom(text))).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("handles chunk boundaries within a frame", async () => {
		const chunks = [`event: message\ndata: {"big":"payl`, `oad","more":42}\n\n`];
		expect(await collect(streamChunked(chunks))).toEqual([{ big: "payload", more: 42 }]);
	});

	it("handles chunk boundary at the \\n\\n delimiter", async () => {
		const chunks = [`event: message\ndata: {"x":1}\n`, `\nevent: message\ndata: {"y":2}\n\n`];
		expect(await collect(streamChunked(chunks))).toEqual([{ x: 1 }, { y: 2 }]);
	});

	it("yields trailing frame with no terminating newlines (best-effort)", async () => {
		const text = `event: message\ndata: {"trailing":true}`;
		expect(await collect(streamFrom(text))).toEqual([{ trailing: true }]);
	});

	it("ignores non-data fields gracefully", async () => {
		const text = `id: 1\nevent: message\ndata: {"ok":true}\n\n`;
		expect(await collect(streamFrom(text))).toEqual([{ ok: true }]);
	});
});
