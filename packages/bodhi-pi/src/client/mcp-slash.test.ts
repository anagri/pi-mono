import { describe, expect, it } from "vitest";
import { parseMcpAddArgs } from "./mcp-slash.js";

describe("parseMcpAddArgs", () => {
	it("returns the parsed JSON object", () => {
		const r = parseMcpAddArgs([`{"url":"https://x/mcp","auth":"public"}`]);
		expect(r.error).toBeUndefined();
		expect(r.value).toEqual({ url: "https://x/mcp", auth: "public" });
	});

	it("rejoins tokens split by shell whitespace before parsing", () => {
		const r = parseMcpAddArgs(["{", '"url":"https://x/mcp",', '"auth":"public"', "}"]);
		expect(r.error).toBeUndefined();
		expect(r.value).toEqual({ url: "https://x/mcp", auth: "public" });
	});

	it("returns an error for empty input", () => {
		const r = parseMcpAddArgs([]);
		expect(r.error).toMatch(/expects one JSON object/);
	});

	it("returns an error for invalid JSON", () => {
		const r = parseMcpAddArgs(["{not-json}"]);
		expect(r.error).toMatch(/invalid JSON/);
	});

	it("rejects JSON arrays — argument must be an object", () => {
		const r = parseMcpAddArgs(["[1,2,3]"]);
		expect(r.error).toMatch(/must be a JSON object/);
	});

	it("rejects JSON primitives — argument must be an object", () => {
		const r = parseMcpAddArgs(['"hello"']);
		expect(r.error).toMatch(/must be a JSON object/);
	});

	it("passes through nested headers/queries unchanged", () => {
		const r = parseMcpAddArgs([
			`{"url":"https://x/mcp","auth":"http-param","headers":{"Authorization":"Bearer X"},"queries":{"api_key":"k1"}}`,
		]);
		expect(r.value).toEqual({
			url: "https://x/mcp",
			auth: "http-param",
			headers: { Authorization: "Bearer X" },
			queries: { api_key: "k1" },
		});
	});
});
