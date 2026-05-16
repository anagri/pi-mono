import { describe, expect, it } from "vitest";
import { maskSecrets } from "../kv/kv-store.js";
import { type McpServerEntry, parseMcpServerEntry, serializeMcpServerEntry } from "./mcp-types.js";

const httpEntry: McpServerEntry = {
	transport: "http",
	url: "https://mcp.github.com/mcp",
	auth: { mode: "public" },
	label: "GitHub",
	addedAt: "2026-05-15T00:00:00.000Z",
	lastKnownStatus: "connected",
};

const stdioEntry: McpServerEntry = {
	transport: "stdio",
	command: "npx",
	args: ["-y", "@modelcontextprotocol/server-everything", "stdio"],
	env: [{ name: "FOO", value: "bar", secret: true }],
	auth: { mode: "public" },
	label: "everything",
	addedAt: "2026-05-15T00:00:00.000Z",
	lastKnownStatus: "disconnected",
};

describe("serialize + parse round-trip", () => {
	it("preserves http entries", () => {
		const wire = serializeMcpServerEntry(httpEntry);
		const back = parseMcpServerEntry(wire);
		expect(back).toEqual(httpEntry);
	});

	it("preserves stdio entries", () => {
		const wire = serializeMcpServerEntry(stdioEntry);
		const back = parseMcpServerEntry(wire);
		expect(back).toEqual(stdioEntry);
	});
});

describe("parseMcpServerEntry rejects malformed shapes", () => {
	it("rejects http without url", () => {
		const bad = {
			transport: "http",
			auth: { mode: "public" },
			label: "x",
			addedAt: "x",
			lastKnownStatus: "disconnected",
		};
		expect(parseMcpServerEntry(bad)).toBeNull();
	});

	it("rejects stdio without command", () => {
		const bad = {
			transport: "stdio",
			auth: { mode: "public" },
			label: "x",
			addedAt: "x",
			lastKnownStatus: "disconnected",
		};
		expect(parseMcpServerEntry(bad)).toBeNull();
	});

	it("rejects unknown transport", () => {
		const bad = {
			transport: "ws",
			url: "x",
			auth: { mode: "public" },
			label: "x",
			addedAt: "x",
			lastKnownStatus: "disconnected",
		};
		expect(parseMcpServerEntry(bad)).toBeNull();
	});

	it("rejects non-public auth mode", () => {
		const bad = serializeMcpServerEntry(httpEntry) as { [k: string]: unknown };
		(bad.auth as { [k: string]: unknown }).mode = "header";
		expect(parseMcpServerEntry(bad as never)).toBeNull();
	});
});

describe("kvStore masking compatibility", () => {
	it("masks stdio env secrets", () => {
		const wire = serializeMcpServerEntry(stdioEntry);
		const masked = maskSecrets(wire) as {
			env: Array<{ name: string; value: string }>;
		};
		expect(masked.env[0].name).toBe("FOO");
		expect(masked.env[0].value).toBe("***");
	});
});
