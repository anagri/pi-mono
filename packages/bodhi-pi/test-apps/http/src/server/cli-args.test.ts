import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "./cli-args.js";

describe("parseArgs", () => {
	it("returns empty for no args", () => {
		expect(parseArgs([])).toEqual({});
	});

	it("parses --port as integer", () => {
		expect(parseArgs(["--port", "0"])).toEqual({ port: 0 });
		expect(parseArgs(["--port", "3000"])).toEqual({ port: 3000 });
	});

	it("rejects non-integer --port", () => {
		expect(() => parseArgs(["--port", "abc"])).toThrow(/--port/);
	});

	it("rejects --port out of range", () => {
		expect(() => parseArgs(["--port", "99999"])).toThrow(/--port/);
		expect(() => parseArgs(["--port", "-1"])).toThrow(/--port/);
	});

	it("rejects unknown flags", () => {
		expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
	});

	describe("--workspace", () => {
		let tmp: string;
		beforeEach(() => {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-http-cli-test-"));
		});
		afterEach(() => {
			fs.rmSync(tmp, { recursive: true, force: true });
		});

		it("accepts an existing directory", () => {
			expect(parseArgs(["--workspace", tmp])).toEqual({ workspace: path.resolve(tmp) });
		});

		it("rejects a missing directory", () => {
			const missing = path.join(tmp, "nope");
			expect(() => parseArgs(["--workspace", missing])).toThrow(/not an existing directory/);
		});
	});

	it("--data-dir resolves absolute path", () => {
		const r = parseArgs(["--data-dir", "./foo"]);
		expect(r.dataDir).toBe(path.resolve("./foo"));
	});
});
