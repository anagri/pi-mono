import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeSseEvent, writeSseHeaders } from "./sse.js";

interface FakeRes {
	headers?: Record<string, string | number>;
	statusCode?: number;
	chunks: string[];
}

function fakeRes(): FakeRes & {
	writeHead: (code: number, h: Record<string, string | number>) => void;
	write: (s: string) => boolean;
} {
	const r: FakeRes = { chunks: [] };
	return Object.assign(r, {
		writeHead(code: number, h: Record<string, string | number>) {
			r.statusCode = code;
			r.headers = h;
		},
		write(s: string): boolean {
			r.chunks.push(s);
			return true;
		},
	});
}

describe("sse writer", () => {
	it("writeSseHeaders sets event-stream content type and disables buffering", () => {
		const res = fakeRes();
		writeSseHeaders(res as never);
		expect(res.statusCode).toBe(200);
		expect(res.headers?.["content-type"]).toMatch(/text\/event-stream/);
		expect(res.headers?.["cache-control"]).toMatch(/no-cache/);
		expect(res.headers?.["x-accel-buffering"]).toBe("no");
	});

	it("writeSseEvent formats event/data/\\n\\n", () => {
		const res = fakeRes();
		writeSseEvent(res as never, { foo: "bar" });
		expect(res.chunks.join("")).toBe(`event: message\ndata: {"foo":"bar"}\n\n`);
	});

	it("writeSseEvent escapes embedded newlines via JSON encoding", () => {
		const res = fakeRes();
		writeSseEvent(res as never, { text: "line1\nline2" });
		// JSON encodes \n inside strings — no literal \n leaks into the data line
		const out = res.chunks.join("");
		expect(out).toMatch(/data: {"text":"line1\\nline2"}/);
		expect(out.endsWith("\n\n")).toBe(true);
	});

	it("works with a real Node stream", async () => {
		const through = new PassThrough();
		const collected: string[] = [];
		through.on("data", (c) => collected.push(c.toString("utf8")));
		// Simulate ServerResponse#write surface
		const writer = {
			writeHead() {},
			write(s: string) {
				through.write(s);
				return true;
			},
		};
		writeSseEvent(writer as never, { hi: 1 });
		through.end();
		await new Promise((r) => through.on("end", r));
		expect(collected.join("")).toBe(`event: message\ndata: {"hi":1}\n\n`);
	});
});
