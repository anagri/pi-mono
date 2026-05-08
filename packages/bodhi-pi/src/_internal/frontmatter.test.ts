import { describe, expect, test } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

interface Sample {
	title?: string;
	count?: number;
}

describe("parseFrontmatter", () => {
	test("no frontmatter returns empty object and full body", () => {
		const { frontmatter, body } = parseFrontmatter<Sample>("hello\nworld");
		expect(frontmatter).toEqual({});
		expect(body).toBe("hello\nworld");
	});

	test("well-formed frontmatter is parsed", () => {
		const { frontmatter, body } = parseFrontmatter<Sample>("---\ntitle: hi\ncount: 3\n---\nbody here\n");
		expect(frontmatter).toEqual({ title: "hi", count: 3 });
		expect(body).toBe("body here\n");
	});

	test("empty frontmatter block returns empty object", () => {
		const { frontmatter, body } = parseFrontmatter<Sample>("---\n\n---\nbody\n");
		expect(frontmatter).toEqual({});
		expect(body).toBe("body\n");
	});

	test("malformed YAML throws", () => {
		expect(() => parseFrontmatter<Sample>("---\ntitle: [unclosed\n---\nbody\n")).toThrow();
	});

	test("CRLF line endings are accepted", () => {
		const { frontmatter, body } = parseFrontmatter<Sample>("---\r\ntitle: ok\r\n---\r\nbody\r\n");
		expect(frontmatter).toEqual({ title: "ok" });
		expect(body).toBe("body\r\n");
	});
});
