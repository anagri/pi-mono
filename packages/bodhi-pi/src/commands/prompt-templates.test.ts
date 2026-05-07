/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: tests cover bash-style ${@:N} substitution literals */
import { describe, expect, test } from "vitest";
import { expandPromptTemplate, type PromptTemplate, parseCommandArgs, substituteArgs } from "./prompt-templates.js";

describe("parseCommandArgs", () => {
	test("empty string returns empty array", () => {
		expect(parseCommandArgs("")).toEqual([]);
	});

	test("single word", () => {
		expect(parseCommandArgs("hello")).toEqual(["hello"]);
	});

	test("multiple space-separated words", () => {
		expect(parseCommandArgs("a b c")).toEqual(["a", "b", "c"]);
	});

	test("collapses runs of spaces", () => {
		expect(parseCommandArgs("a   b\tc")).toEqual(["a", "b", "c"]);
	});

	test("double-quoted string preserves spaces", () => {
		expect(parseCommandArgs('"hello world" foo')).toEqual(["hello world", "foo"]);
	});

	test("single-quoted string preserves spaces", () => {
		expect(parseCommandArgs("'hello world' foo")).toEqual(["hello world", "foo"]);
	});

	test("mixed quote styles", () => {
		expect(parseCommandArgs(`"a b" 'c d' e`)).toEqual(["a b", "c d", "e"]);
	});

	test("trailing whitespace", () => {
		expect(parseCommandArgs("a b   ")).toEqual(["a", "b"]);
	});
});

describe("substituteArgs", () => {
	test("$1, $2 positional", () => {
		expect(substituteArgs("$1 then $2", ["foo", "bar"])).toBe("foo then bar");
	});

	test("missing positional substitutes empty string", () => {
		expect(substituteArgs("[$1] [$2] [$3]", ["only-one"])).toBe("[only-one] [] []");
	});

	test("$@ joins all args with space", () => {
		expect(substituteArgs("got: $@", ["a", "b", "c"])).toBe("got: a b c");
	});

	test("$ARGUMENTS is alias for $@", () => {
		expect(substituteArgs("got: $ARGUMENTS", ["a", "b", "c"])).toBe("got: a b c");
	});

	test("${@:2} slice from N onwards", () => {
		expect(substituteArgs("rest: ${@:2}", ["a", "b", "c", "d"])).toBe("rest: b c d");
	});

	test("${@:N:L} slice with length", () => {
		expect(substituteArgs("middle: ${@:2:2}", ["a", "b", "c", "d"])).toBe("middle: b c");
	});

	test("${@:0} treats 0 as 1", () => {
		expect(substituteArgs("all: ${@:0}", ["x", "y"])).toBe("all: x y");
	});

	test("argument value containing $1 is NOT re-substituted", () => {
		expect(substituteArgs("$1 vs $2", ["$2", "actual"])).toBe("$2 vs actual");
	});

	test("mix of all forms", () => {
		expect(substituteArgs("first=$1 all=$@ rest=${@:2}", ["a", "b", "c"])).toBe("first=a all=a b c rest=b c");
	});

	test("non-numeric slice index left as literal", () => {
		expect(substituteArgs("noop ${@:foo}", ["a"])).toBe("noop ${@:foo}");
	});
});

describe("expandPromptTemplate", () => {
	const templates: PromptTemplate[] = [
		{ name: "echo", description: "echo", content: "Reply: $1", filePath: "/echo.md" },
		{ name: "tuesday", description: "tuesday", content: 'Reply with "tuesday".', filePath: "/tuesday.md" },
	];

	test("text without leading slash is unchanged", () => {
		expect(expandPromptTemplate("hello there", templates)).toBe("hello there");
	});

	test("unknown command is passed through verbatim", () => {
		expect(expandPromptTemplate("/unknown arg", templates)).toBe("/unknown arg");
	});

	test("known command no args", () => {
		expect(expandPromptTemplate("/tuesday", templates)).toBe('Reply with "tuesday".');
	});

	test("known command with args", () => {
		expect(expandPromptTemplate("/echo banana", templates)).toBe("Reply: banana");
	});

	test("known command with extra trailing whitespace", () => {
		expect(expandPromptTemplate("/echo banana   ", templates)).toBe("Reply: banana");
	});

	test("empty templates list with leading slash → unchanged", () => {
		expect(expandPromptTemplate("/anything", [])).toBe("/anything");
	});
});
