import { describe, expect, test } from "vitest";
import { parseSlashArgs } from "./slash-args.js";

describe("parseSlashArgs", () => {
	test("empty input returns empty positionals and kwargs", () => {
		expect(parseSlashArgs("")).toEqual({ positionals: [], kwargs: {} });
		expect(parseSlashArgs("   ")).toEqual({ positionals: [], kwargs: {} });
	});

	test("bare positionals", () => {
		expect(parseSlashArgs("openai")).toEqual({ positionals: ["openai"], kwargs: {} });
		expect(parseSlashArgs("foo bar")).toEqual({ positionals: ["foo", "bar"], kwargs: {} });
	});

	test("bareword kwargs", () => {
		expect(parseSlashArgs("api_key=sk-1")).toEqual({ positionals: [], kwargs: { api_key: "sk-1" } });
	});

	test("positional + kwargs mixed", () => {
		const out = parseSlashArgs('openai api_key="sk-abc" base_url=http://x');
		expect(out).toEqual({
			positionals: ["openai"],
			kwargs: { api_key: "sk-abc", base_url: "http://x" },
		});
	});

	test("double-quoted value preserves embedded spaces", () => {
		expect(parseSlashArgs('msg="hello world"')).toEqual({
			positionals: [],
			kwargs: { msg: "hello world" },
		});
	});

	test("single-quoted value preserves embedded spaces", () => {
		expect(parseSlashArgs("msg='hi there'")).toEqual({
			positionals: [],
			kwargs: { msg: "hi there" },
		});
	});

	test("escaped quote inside a quoted value", () => {
		expect(parseSlashArgs('msg="a\\"b"')).toEqual({
			positionals: [],
			kwargs: { msg: 'a"b' },
		});
	});

	test("unterminated quote throws", () => {
		expect(() => parseSlashArgs('msg="hello')).toThrow(/unterminated/);
	});

	test("empty key throws", () => {
		expect(() => parseSlashArgs("=value")).toThrow(/empty key/);
	});

	test("kwarg with empty value is allowed", () => {
		expect(parseSlashArgs("k=")).toEqual({ positionals: [], kwargs: { k: "" } });
		expect(parseSlashArgs('k=""')).toEqual({ positionals: [], kwargs: { k: "" } });
	});
});
