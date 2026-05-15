import { describe, expect, it } from "vitest";
import { createInMemoryKvStore } from "../kv/in-memory-kv-store.js";
import { resolveUniqueSlug, slugifyCommand, slugifyUrl } from "./mcp-slug.js";
import { MCP_PREFIX } from "./mcp-types.js";

describe("slugifyUrl", () => {
	it("strips the leading mcp. label", () => {
		expect(slugifyUrl("https://mcp.github.com/mcp")).toBe("github");
	});

	it("strips the trailing tld label", () => {
		expect(slugifyUrl("https://api.example.io/mcp")).toBe("example");
	});

	it("returns the leftmost meaningful label for multi-level hosts", () => {
		expect(slugifyUrl("https://foo.bar.baz.com")).toBe("foo");
	});

	it("sanitizes invalid characters to hyphens", () => {
		expect(slugifyUrl("https://mcp.foo_bar.example.com")).toBe("foo-bar");
	});

	it("returns empty for unparseable URLs", () => {
		expect(slugifyUrl("not a url")).toBe("");
	});
});

describe("slugifyCommand", () => {
	it("extracts the package name from npx invocations", () => {
		expect(slugifyCommand("npx", ["-y", "@modelcontextprotocol/server-github"])).toBe("server-github");
	});

	it("strips scope prefixes", () => {
		expect(slugifyCommand("npx", ["@scope/foo"])).toBe("foo");
	});

	it("falls back to the basename of the command itself", () => {
		expect(slugifyCommand("/usr/bin/my-mcp", undefined)).toBe("my-mcp");
	});
});

describe("resolveUniqueSlug", () => {
	it("returns the candidate when no collision exists", async () => {
		const kv = createInMemoryKvStore();
		expect(await resolveUniqueSlug("github", kv)).toBe("github");
	});

	it("appends a 5-char suffix on collision", async () => {
		const kv = createInMemoryKvStore();
		await kv.set(`${MCP_PREFIX}github`, { stub: true });
		const slug = await resolveUniqueSlug("github", kv);
		expect(slug).toMatch(/^github-[0-9a-f]{5}$/);
	});

	it("uses 'mcp' when the candidate is empty", async () => {
		const kv = createInMemoryKvStore();
		expect(await resolveUniqueSlug("", kv)).toBe("mcp");
	});
});
