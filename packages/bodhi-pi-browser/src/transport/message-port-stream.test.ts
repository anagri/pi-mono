import { MessageChannel } from "node:worker_threads";
import { describe, expect, test } from "vitest";
import { createMessagePortStream } from "./message-port-stream.js";

// Node's worker_threads MessageChannel produces ports that are structurally
// compatible with the DOM `MessagePort` shape this helper consumes (start /
// onmessage / onmessageerror / postMessage(value, transferList)). We cast at
// the boundary because their TypeScript declarations live in different libs.
function pair() {
	const channel = new MessageChannel();
	return {
		port1: channel.port1 as unknown as MessagePort,
		port2: channel.port2 as unknown as MessagePort,
	};
}

describe("createMessagePortStream", () => {
	test("round-trips a Uint8Array between two ports", async () => {
		const { port1, port2 } = pair();
		const a = createMessagePortStream(port1);
		const b = createMessagePortStream(port2);

		const writer = a.writable.getWriter();
		await writer.write(new TextEncoder().encode("hello"));
		writer.releaseLock();

		const reader = b.readable.getReader();
		const { value, done } = await reader.read();
		expect(done).toBe(false);
		expect(value).toBeInstanceOf(Uint8Array);
		expect(new TextDecoder().decode(value)).toBe("hello");
	});

	test("preserves multiple sequential frames in order", async () => {
		const { port1, port2 } = pair();
		const a = createMessagePortStream(port1);
		const b = createMessagePortStream(port2);

		const writer = a.writable.getWriter();
		const enc = new TextEncoder();
		await writer.write(enc.encode("first\n"));
		await writer.write(enc.encode("second\n"));
		await writer.write(enc.encode("third\n"));
		writer.releaseLock();

		const reader = b.readable.getReader();
		const dec = new TextDecoder();
		const frames: string[] = [];
		for (let i = 0; i < 3; i++) {
			const { value } = await reader.read();
			frames.push(dec.decode(value));
		}
		expect(frames).toEqual(["first\n", "second\n", "third\n"]);
	});

	test("decodes string payloads as UTF-8 bytes", async () => {
		const { port1, port2 } = pair();
		const b = createMessagePortStream(port2);

		// Bypass the helper on the writer side and post a raw string directly.
		(port1 as unknown as { postMessage(v: unknown): void }).postMessage("plain-string");

		const reader = b.readable.getReader();
		const { value } = await reader.read();
		expect(new TextDecoder().decode(value)).toBe("plain-string");
	});

	test("port.close() during a pending read terminates the reader without hanging", async () => {
		const { port1, port2 } = pair();
		const b = createMessagePortStream(port2);

		const reader = b.readable.getReader();

		// Issue a read before any write; reader stalls until a frame arrives or
		// the underlying port closes. Close port1 — this is the worst-case
		// failure mode for the transport (silent hang).
		const readPromise = reader.read();

		// Give the read a microtask tick before closing.
		await new Promise((r) => setImmediate(r));

		(port1 as unknown as { close(): void }).close();
		(port2 as unknown as { close(): void }).close();

		// Race against a short timeout. If `read()` never resolves/rejects, the
		// timeout wins and we know the transport is wedged.
		type Settled = { kind: "ok" } | { kind: "err" } | { kind: "timeout" };
		const settledPromise: Promise<Settled> = readPromise.then(
			() => ({ kind: "ok" as const }),
			() => ({ kind: "err" as const }),
		);
		const timeoutPromise: Promise<Settled> = new Promise((r) => setTimeout(() => r({ kind: "timeout" }), 500));
		const result = await Promise.race([settledPromise, timeoutPromise]);

		expect(result.kind, "reader must settle within 500ms of port.close()").not.toBe("timeout");
	});
});
