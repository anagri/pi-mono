import { describe, expect, it } from "vitest";
import { maskSecrets } from "../kv/kv-store.js";
import { type McpServerEntry, parseMcpServerEntry, serializeMcpServerEntry } from "./mcp-types.js";

const httpEntry: McpServerEntry = {
	transport: "http",
	url: "https://mcp.github.com/mcp",
	auth: {
		mode: "header",
		headers: [{ name: "Authorization", value: "Bearer abc", secret: true }],
	},
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

	it("preserves oauth tokens", () => {
		const entry: McpServerEntry = {
			...httpEntry,
			auth: {
				mode: "oauth-dcr",
				clientId: "cid",
				clientSecret: { value: "csec", secret: true },
				tokens: {
					access: { value: "at", secret: true },
					refresh: { value: "rt", secret: true },
					expiresAt: 1_700_000_000_000,
				},
			},
		};
		const back = parseMcpServerEntry(serializeMcpServerEntry(entry));
		expect(back).toEqual(entry);
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
		(bad.auth as { [k: string]: unknown }).mode = "bogus";
		expect(parseMcpServerEntry(bad as never)).toBeNull();
	});
});

describe("kvStore masking compatibility", () => {
	it("masks secret-tagged values on read", () => {
		const wire = serializeMcpServerEntry(httpEntry);
		const masked = maskSecrets(wire) as {
			auth: { headers: Array<{ name: string; value: string }> };
		};
		expect(masked.auth.headers[0].name).toBe("Authorization");
		expect(masked.auth.headers[0].value).toBe("***");
	});

	it("masks oauth tokens", () => {
		const entry: McpServerEntry = {
			...httpEntry,
			auth: {
				mode: "oauth-dcr",
				tokens: { access: { value: "secret-token", secret: true } },
			},
		};
		const masked = maskSecrets(serializeMcpServerEntry(entry)) as {
			auth: { tokens: { access: { value: string } } };
		};
		expect(masked.auth.tokens.access.value).toBe("***");
	});
});
