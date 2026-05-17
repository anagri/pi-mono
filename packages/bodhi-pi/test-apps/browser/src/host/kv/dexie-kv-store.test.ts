import { maskSecrets, serializeMcpServerEntry } from "@bodhiapp/bodhi-pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDexieKvStore } from "./dexie-kv-store.js";

// Browser Dexie KV round-trip for the http-param MCP auth entry shape.
// The store is opaque JSON — Dexie holds a single `json` string per key. chrome-ext
// reuses this adapter via subpath import, so coverage here covers both runtimes.

let dbName: string;
let kv: ReturnType<typeof createDexieKvStore>;

beforeEach(() => {
	// Unique dbName per test prevents cross-test pollution under fake-indexeddb's
	// shared in-process IDB instance.
	dbName = `bodhi-pi-test-kv-${Math.random().toString(36).slice(2)}`;
	kv = createDexieKvStore({ dbName });
});

afterEach(async () => {
	// Drop the database so the next test starts clean. fake-indexeddb persists
	// across tests within the same process if we don't.
	const Dexie = (await import("dexie")).default;
	await Dexie.delete(dbName);
});

describe("Dexie KvStore round-trip — http-param McpServerEntry", () => {
	it("preserves the auth blob (headers + queries) byte-for-byte", async () => {
		const wire = serializeMcpServerEntry({
			transport: "http",
			url: "https://mcp.example/mcp",
			auth: {
				mode: "http-param",
				headers: [
					{ name: "Authorization", value: "Bearer secret-token", secret: true },
					{ name: "X-Trace", value: "abc", secret: true },
				],
				queries: [{ name: "api_key", value: "k1", secret: true }],
			},
			label: "example",
			addedAt: "2026-05-17T00:00:00.000Z",
			lastKnownStatus: "disconnected",
		});

		await kv.set("mcp/example", wire);
		const round = await kv.get("mcp/example");
		expect(round).toEqual(wire);
	});

	it("list() with prefix returns the entry intact", async () => {
		const wire = serializeMcpServerEntry({
			transport: "http",
			url: "https://mcp.example/mcp",
			auth: { mode: "http-param", queries: [{ name: "api_key", value: "k1", secret: true }] },
			label: "example",
			addedAt: "2026-05-17T00:00:00.000Z",
			lastKnownStatus: "disconnected",
		});
		await kv.set("mcp/example", wire);
		await kv.set("other/key", { unrelated: true });

		const entries = await kv.list("mcp/");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.key).toBe("mcp/example");
		expect(entries[0]!.value).toEqual(wire);
	});

	it("maskSecrets applied to the persisted blob masks both headers and queries", async () => {
		const wire = serializeMcpServerEntry({
			transport: "http",
			url: "https://mcp.example/mcp",
			auth: {
				mode: "http-param",
				headers: [{ name: "Authorization", value: "Bearer secret", secret: true }],
				queries: [{ name: "api_key", value: "k1", secret: true }],
			},
			label: "example",
			addedAt: "2026-05-17T00:00:00.000Z",
			lastKnownStatus: "disconnected",
		});
		await kv.set("mcp/example", wire);
		const stored = (await kv.get("mcp/example"))!;
		const masked = maskSecrets(stored) as {
			auth: { headers: Array<{ value: string }>; queries: Array<{ value: string }> };
		};
		expect(masked.auth.headers[0]!.value).toBe("***");
		expect(masked.auth.queries[0]!.value).toBe("***");
	});

	it("remove() drops the entry", async () => {
		const wire = serializeMcpServerEntry({
			transport: "http",
			url: "https://mcp.example/mcp",
			auth: { mode: "http-param", headers: [{ name: "Authorization", value: "Bearer s", secret: true }] },
			label: "example",
			addedAt: "2026-05-17T00:00:00.000Z",
			lastKnownStatus: "disconnected",
		});
		await kv.set("mcp/example", wire);
		await kv.remove("mcp/example");
		expect(await kv.get("mcp/example")).toBeUndefined();
	});
});
