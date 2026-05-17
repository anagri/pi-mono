import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type KvStore, maskSecrets, serializeMcpServerEntry } from "@bodhiapp/bodhi-pi";
import { createNodeKvStore } from "./kv-store.js";

// Node-side KV adapter round-trip for the http-param MCP auth entry shape.
// The store is file-backed opaque JSON — no schema knowledge of `auth`, `headers`,
// or `queries`. Zero adapter-source change is the explicit slice 4 expectation;
// this test pins that contract.

let dir: string;
let kv: KvStore;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bodhi-pi-node-kv-test-"));
	kv = createNodeKvStore({ dir });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("Node KvStore round-trip — http-param McpServerEntry", () => {
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

	it("writes secret-containing entries with 0o600 file mode", async () => {
		const wire = serializeMcpServerEntry({
			transport: "http",
			url: "https://mcp.example/mcp",
			auth: {
				mode: "http-param",
				headers: [{ name: "Authorization", value: "Bearer s", secret: true }],
			},
			label: "example",
			addedAt: "2026-05-17T00:00:00.000Z",
			lastKnownStatus: "disconnected",
		});
		await kv.set("mcp/example", wire);

		const files = await listJsonFiles(dir);
		expect(files).toHaveLength(1);
		const mode = (await stat(path.join(dir, files[0]!))).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("list() returns the persisted entry intact under an mcp/ prefix scan", async () => {
		const wire = serializeMcpServerEntry({
			transport: "http",
			url: "https://mcp.example/mcp",
			auth: { mode: "http-param", queries: [{ name: "api_key", value: "k1", secret: true }] },
			label: "example",
			addedAt: "2026-05-17T00:00:00.000Z",
			lastKnownStatus: "disconnected",
		});
		await kv.set("mcp/example", wire);

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
		const masked = maskSecrets(stored) as { auth: { headers: Array<{ value: string }>; queries: Array<{ value: string }> } };
		expect(masked.auth.headers[0]!.value).toBe("***");
		expect(masked.auth.queries[0]!.value).toBe("***");
	});
});

async function listJsonFiles(dir: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(dir);
	return entries.filter((f) => f.endsWith(".json"));
}
