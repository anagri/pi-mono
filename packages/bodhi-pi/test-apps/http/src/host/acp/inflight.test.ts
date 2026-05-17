import { describe, expect, it } from "vitest";
import { createInflightRegistry } from "./inflight.js";

describe("inflight registry", () => {
	it("returns a fresh AbortController on register", () => {
		const reg = createInflightRegistry();
		const ctrl = reg.register("s1");
		expect(ctrl.signal.aborted).toBe(false);
	});

	it("abort(sessionId) aborts the registered controller", () => {
		const reg = createInflightRegistry();
		const ctrl = reg.register("s1");
		reg.abort("s1");
		expect(ctrl.signal.aborted).toBe(true);
	});

	it("abort is a no-op for unknown sessionId", () => {
		const reg = createInflightRegistry();
		expect(() => reg.abort("nope")).not.toThrow();
	});

	it("release(sessionId) removes the entry; subsequent abort is a no-op", () => {
		const reg = createInflightRegistry();
		const ctrl = reg.register("s1");
		reg.release("s1");
		reg.abort("s1");
		expect(ctrl.signal.aborted).toBe(false);
	});

	it("re-registering a sessionId aborts the previous controller", () => {
		const reg = createInflightRegistry();
		const c1 = reg.register("s1");
		const c2 = reg.register("s1");
		expect(c1.signal.aborted).toBe(true);
		expect(c2.signal.aborted).toBe(false);
	});
});
