import { expect, test } from "vitest";
import { withFileMutationQueue } from "@/tools/file-mutation-queue.js";

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test("withFileMutationQueue serialises operations on the same path", async () => {
	const events: string[] = [];
	const gateA = defer<void>();
	const gateB = defer<void>();

	const a = withFileMutationQueue("/same", async () => {
		events.push("A:start");
		await gateA.promise;
		events.push("A:end");
		return "A";
	});
	// Schedule B while A is in flight. B must wait for A's release.
	const b = withFileMutationQueue("/same", async () => {
		events.push("B:start");
		await gateB.promise;
		events.push("B:end");
		return "B";
	});

	// Let A start, then release in order.
	await Promise.resolve();
	expect(events).toEqual(["A:start"]);
	gateA.resolve();
	await a;
	// Flush microtasks so B's queued fn enters.
	await Promise.resolve();
	await Promise.resolve();
	expect(events).toEqual(["A:start", "A:end", "B:start"]);
	gateB.resolve();
	await b;
	expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
});

test("withFileMutationQueue runs operations on different paths in parallel", async () => {
	const events: string[] = [];
	const gateA = defer<void>();
	const gateB = defer<void>();

	const a = withFileMutationQueue("/path-a", async () => {
		events.push("A:start");
		await gateA.promise;
		events.push("A:end");
	});
	const b = withFileMutationQueue("/path-b", async () => {
		events.push("B:start");
		await gateB.promise;
		events.push("B:end");
	});

	// Both fns enter before either resolves.
	await Promise.resolve();
	await Promise.resolve();
	expect(events).toContain("A:start");
	expect(events).toContain("B:start");

	// Release in reverse order — B finishes before A.
	gateB.resolve();
	await b;
	gateA.resolve();
	await a;
	expect(events).toEqual(["A:start", "B:start", "B:end", "A:end"]);
});

test("withFileMutationQueue releases the lock even when fn throws", async () => {
	await expect(
		withFileMutationQueue("/throws", async () => {
			throw new Error("boom");
		}),
	).rejects.toThrow("boom");
	// A subsequent call on the same path proceeds without hanging.
	const result = await withFileMutationQueue("/throws", async () => "ok");
	expect(result).toBe("ok");
});
