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

const httpHeaderEntry: McpServerEntry = {
	transport: "http",
	url: "https://mcp.example/mcp",
	auth: {
		mode: "http-param",
		headers: [{ name: "Authorization", value: "Bearer secret-token", secret: true }],
	},
	label: "example",
	addedAt: "2026-05-17T00:00:00.000Z",
	lastKnownStatus: "disconnected",
};

const httpMixedEntry: McpServerEntry = {
	transport: "http",
	url: "https://mcp.example/mcp",
	auth: {
		mode: "http-param",
		headers: [{ name: "X-Trace", value: "abc", secret: true }],
		queries: [{ name: "api_key", value: "k1", secret: true }],
	},
	label: "example",
	addedAt: "2026-05-17T00:00:00.000Z",
	lastKnownStatus: "disconnected",
};

describe("serialize + parse round-trip", () => {
	it("preserves http public entries", () => {
		const wire = serializeMcpServerEntry(httpEntry);
		expect(parseMcpServerEntry(wire)).toEqual(httpEntry);
	});

	it("preserves stdio entries", () => {
		const wire = serializeMcpServerEntry(stdioEntry);
		expect(parseMcpServerEntry(wire)).toEqual(stdioEntry);
	});

	it("preserves http http-param entries with headers only", () => {
		const wire = serializeMcpServerEntry(httpHeaderEntry);
		expect(parseMcpServerEntry(wire)).toEqual(httpHeaderEntry);
	});

	it("preserves http http-param entries with both headers and queries", () => {
		const wire = serializeMcpServerEntry(httpMixedEntry);
		expect(parseMcpServerEntry(wire)).toEqual(httpMixedEntry);
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

	it("rejects unknown auth mode", () => {
		const bad = serializeMcpServerEntry(httpEntry) as { [k: string]: unknown };
		(bad.auth as { [k: string]: unknown }).mode = "oauth-dcr";
		expect(parseMcpServerEntry(bad as never)).toBeNull();
	});

	it("rejects http-param entry with no headers or queries (indistinguishable from public)", () => {
		const bad = {
			transport: "http",
			url: "https://x/mcp",
			auth: { mode: "http-param" },
			label: "x",
			addedAt: "x",
			lastKnownStatus: "disconnected",
		};
		expect(parseMcpServerEntry(bad)).toBeNull();
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

	it("masks http-param header and query values inside the auth blob", () => {
		const wire = serializeMcpServerEntry(httpMixedEntry);
		const masked = maskSecrets(wire) as {
			auth: {
				mode: string;
				headers: Array<{ name: string; value: string }>;
				queries: Array<{ name: string; value: string }>;
			};
		};
		expect(masked.auth.mode).toBe("http-param");
		expect(masked.auth.headers).toEqual([{ name: "X-Trace", value: "***", secret: true }]);
		expect(masked.auth.queries).toEqual([{ name: "api_key", value: "***", secret: true }]);
	});
});
