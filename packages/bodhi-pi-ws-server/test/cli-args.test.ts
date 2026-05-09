import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli-args.js";

describe("parseArgs", () => {
	let tmp: string;

	beforeAll(() => {
		tmp = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-ws-cli-args-"));
	});
	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty object for no args", () => {
		expect(parseArgs([])).toEqual({});
	});

	it("parses --port as integer", () => {
		expect(parseArgs(["--port", "0"])).toEqual({ port: 0 });
		expect(parseArgs(["--port", "8788"])).toEqual({ port: 8788 });
	});

	it("rejects non-integer port", () => {
		expect(() => parseArgs(["--port", "abc"])).toThrow(/--port/);
	});

	it("rejects out-of-range port", () => {
		expect(() => parseArgs(["--port", "65536"])).toThrow(/--port/);
		expect(() => parseArgs(["--port", "-1"])).toThrow(/--port/);
	});

	it("parses --workspace pointing at an existing directory", () => {
		const out = parseArgs(["--workspace", tmp]);
		expect(out.workspace).toBe(path.resolve(tmp));
	});

	it("rejects --workspace pointing at a non-existent path", () => {
		expect(() => parseArgs(["--workspace", path.join(tmp, "nope")])).toThrow(/workspace/);
	});

	it("rejects unknown flags", () => {
		expect(() => parseArgs(["--bogus", "x"])).toThrow(/unknown flag/);
	});

	it("parses combined flags in any order", () => {
		const out = parseArgs(["--workspace", tmp, "--port", "0"]);
		expect(out).toEqual({ workspace: path.resolve(tmp), port: 0 });
	});

	it("parses --data-dir without requiring it to exist", () => {
		const out = parseArgs(["--data-dir", path.join(tmp, "future-data")]);
		expect(out.dataDir).toBe(path.resolve(path.join(tmp, "future-data")));
	});
});
