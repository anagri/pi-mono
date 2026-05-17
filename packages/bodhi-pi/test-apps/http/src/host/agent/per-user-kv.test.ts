import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	maskSecrets,
	parseMcpServerEntry,
	serializeMcpServerEntry,
	type McpServerEntry,
} from "@bodhiapp/bodhi-pi";
import { createNodeKvStore } from "@bodhiapp/bodhi-pi-test-app-node-adapters/kv-store";

// HTTP host per-user kv isolation. Production wiring (wire-agent-shared.ts:108-110)
// builds the per-user kv dir as `kvDir = path.join(kvRoot, String(opts.user.id))`.
// This test exercises the same shape with two distinct user-id subdirectories,
// asserting (a) one user's http-param auth blob is not visible to another and
// (b) the entry survives a per-turn agent rebuild (fresh kv handle on the same dir).

const entry: McpServerEntry = {
	transport: "http",
	url: "https://mcp.example/mcp",
	auth: {
		mode: "http-param",
		headers: [{ name: "Authorization", value: "Bearer alice-secret", secret: true }],
		queries: [{ name: "api_key", value: "alice-k1", secret: true }],
	},
	label: "alice-mcp",
	addedAt: "2026-05-17T00:00:00.000Z",
	lastKnownStatus: "disconnected",
};

let kvRoot: string;

beforeEach(async () => {
	kvRoot = await mkdtemp(path.join(tmpdir(), "bodhi-pi-http-kv-test-"));
});

afterEach(async () => {
	await rm(kvRoot, { recursive: true, force: true });
});

describe("HTTP host per-user kv isolation for http-param McpServerEntry", () => {
	it("user A's entry is not visible to user B (separate kvDir per user-id)", async () => {
		const aliceKv = createNodeKvStore({ dir: path.join(kvRoot, "1") });
		const bobKv = createNodeKvStore({ dir: path.join(kvRoot, "2") });

		await aliceKv.set("mcp/alice-mcp", serializeMcpServerEntry(entry));

		expect(await bobKv.get("mcp/alice-mcp")).toBeUndefined();
		expect(await bobKv.list("mcp/")).toEqual([]);
	});

	it("entry survives a per-turn agent rebuild (re-instantiating the kv handle on the same dir)", async () => {
		const aliceDir = path.join(kvRoot, "1");
		const aliceKv1 = createNodeKvStore({ dir: aliceDir });
		await aliceKv1.set("mcp/alice-mcp", serializeMcpServerEntry(entry));

		// New kv handle on the same dir == fresh agent after per-turn rebuild.
		const aliceKv2 = createNodeKvStore({ dir: aliceDir });
		const stored = await aliceKv2.get("mcp/alice-mcp");
		expect(stored).toBeDefined();
		const round = parseMcpServerEntry(stored!);
		expect(round).toEqual(entry);
	});

	it("masking applies on read-out for ACP boundary delivery (in-process reads stay plaintext)", async () => {
		const aliceKv = createNodeKvStore({ dir: path.join(kvRoot, "1") });
		await aliceKv.set("mcp/alice-mcp", serializeMcpServerEntry(entry));

		// In-process read of the persisted blob: plaintext (mirrors what the MCP
		// connection client sees when opening the transport).
		const raw = (await aliceKv.get("mcp/alice-mcp"))!;
		const rawAuth = (raw as { auth: { headers: Array<{ value: string }>; queries: Array<{ value: string }> } }).auth;
		expect(rawAuth.headers[0]!.value).toBe("Bearer alice-secret");
		expect(rawAuth.queries[0]!.value).toBe("alice-k1");

		// ACP-bound read goes through maskSecrets (matches what `_bodhi-pi/mcp/list`
		// and `_bodhi-pi/kv/get` ship over the wire).
		const masked = maskSecrets(raw) as {
			auth: { headers: Array<{ value: string }>; queries: Array<{ value: string }> };
		};
		expect(masked.auth.headers[0]!.value).toBe("***");
		expect(masked.auth.queries[0]!.value).toBe("***");
	});
});
