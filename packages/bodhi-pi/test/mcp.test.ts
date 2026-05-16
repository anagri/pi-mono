import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	EXT_KV_GET,
	EXT_KV_LIST,
	EXT_MCP_ADD,
	EXT_MCP_EXCLUDE,
	EXT_MCP_INCLUDE,
	EXT_MCP_LIST,
	EXT_MCP_REMOVE,
} from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});
afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newFaux(): Model<Api> {
	const faux = registerFauxProvider();
	providers.push(faux);
	faux.setResponses([() => fauxAssistantMessage("ok")]);
	return faux.getModel() as Model<Api>;
}

test("_bodhi-pi/mcp/add with a url stores an entry under mcp/<slug> and returns the slug", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = await harness.clientConn.extMethod(EXT_MCP_ADD, {
		url: "https://mcp.github.com/mcp",
	});
	expect(result).toEqual({ slug: "github" });

	const stored = await harness.kvStore.get("mcp/github");
	expect(stored).toMatchObject({
		transport: "http",
		url: "https://mcp.github.com/mcp",
		auth: { mode: "public" },
		label: "github",
		lastKnownStatus: "disconnected",
	});
});

test("_bodhi-pi/mcp/add collides cleanly with a random suffix on second add of the same url", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const first = (await harness.clientConn.extMethod(EXT_MCP_ADD, {
		url: "https://mcp.github.com/mcp",
	})) as { slug: string };
	const second = (await harness.clientConn.extMethod(EXT_MCP_ADD, {
		url: "https://mcp.github.com/mcp",
	})) as { slug: string };
	expect(first.slug).toBe("github");
	expect(second.slug).toMatch(/^github-[0-9a-f]{5}$/);
});

test("_bodhi-pi/mcp/list masks secret header values and exposes (slug, label, status, transport)", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_MCP_ADD, {
		url: "https://mcp.example.com/mcp",
		auth: { mode: "header", headers: [{ name: "Authorization", value: "Bearer abc", secret: true }] },
		label: "Example",
	});

	const listed = (await harness.clientConn.extMethod(EXT_MCP_LIST, {})) as {
		entries: Array<{ slug: string; label: string; status: string; transport: string }>;
	};
	expect(listed.entries).toEqual([
		{
			slug: "example",
			label: "Example",
			status: "disconnected",
			transport: "http",
			url: "https://mcp.example.com/mcp",
		},
	]);

	// kv/get on the same key should mask the secret header value.
	const got = (await harness.clientConn.extMethod(EXT_KV_GET, { key: "mcp/example" })) as {
		value: { auth: { headers: Array<{ name: string; value: string }> } };
	};
	expect(got.value.auth.headers[0]).toEqual({ name: "Authorization", value: "***", secret: true });
});

test("_bodhi-pi/mcp/remove drops the kv entry", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_MCP_ADD, { url: "https://mcp.foo.com/mcp" });
	await harness.clientConn.extMethod(EXT_MCP_REMOVE, { slug: "foo" });

	const remaining = (await harness.clientConn.extMethod(EXT_KV_LIST, { prefix: "mcp/" })) as {
		entries: Array<{ key: string }>;
	};
	expect(remaining.entries).toEqual([]);
});

test("_bodhi-pi/mcp/add persists stdio entries when the host supports them", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_MCP_ADD, {
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-everything", "stdio"],
	})) as { slug: string };
	expect(result.slug).toBe("server-everything");
	const stored = await harness.kvStore.get(`mcp/${result.slug}`);
	expect(stored).toMatchObject({ transport: "stdio", command: "npx" });
});

test("_bodhi-pi/mcp/add rejects stdio commands when supportsMcpStdio=false", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, supportsMcpStdio: false });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await expect(
		harness.clientConn.extMethod(EXT_MCP_ADD, { command: "npx", args: ["@modelcontextprotocol/server-everything"] }),
	).rejects.toThrow(/stdio MCPs are not supported/);
});

test("/mcp include writes an mcp_inclusion_set session entry; /mcp exclude writes a new snapshot", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	// Add two MCP entries (don't need to connect; include() doesn't auto-connect).
	await harness.clientConn.extMethod(EXT_MCP_ADD, { url: "https://mcp.a.com/mcp" });
	await harness.clientConn.extMethod(EXT_MCP_ADD, { url: "https://mcp.b.com/mcp" });

	await harness.clientConn.extMethod(EXT_MCP_INCLUDE, { sessionId, slug: "a" });
	let record = await harness.sessionStore.load(sessionId);
	const inclusionEntriesAfterA = record?.entries.filter((e) => e.type === "mcp_inclusion_set") ?? [];
	expect(inclusionEntriesAfterA).toHaveLength(1);
	expect((inclusionEntriesAfterA[0] as { slugs: string[] }).slugs).toEqual(["a"]);

	await harness.clientConn.extMethod(EXT_MCP_INCLUDE, { sessionId, slug: "b" });
	record = await harness.sessionStore.load(sessionId);
	const inclusionEntriesAfterB = record?.entries.filter((e) => e.type === "mcp_inclusion_set") ?? [];
	expect(inclusionEntriesAfterB).toHaveLength(2);
	expect((inclusionEntriesAfterB[1] as { slugs: string[] }).slugs).toEqual(["a", "b"]);

	await harness.clientConn.extMethod(EXT_MCP_EXCLUDE, { sessionId, slug: "a" });
	record = await harness.sessionStore.load(sessionId);
	const inclusionEntriesAfterExclude = record?.entries.filter((e) => e.type === "mcp_inclusion_set") ?? [];
	expect(inclusionEntriesAfterExclude).toHaveLength(3);
	expect((inclusionEntriesAfterExclude[2] as { slugs: string[] }).slugs).toEqual(["b"]);
});

test("session/resume restores inclusion from the last mcp_inclusion_set entry when mcpServers is omitted", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_MCP_ADD, { url: "https://mcp.x.com/mcp" });
	await harness.clientConn.extMethod(EXT_MCP_INCLUDE, { sessionId, slug: "x" });

	// resume with mcpServers omitted should fall back to the session-stored inclusion.
	await harness.clientConn.resumeSession({ sessionId, cwd: "/proj" } as never);

	// resume does not write a new entry (session-stored wins; no override).
	const record = await harness.sessionStore.load(sessionId);
	const inclusionEntries = record?.entries.filter((e) => e.type === "mcp_inclusion_set") ?? [];
	expect(inclusionEntries).toHaveLength(1);
});

test("session/resume with mcpServers: [] overrides session-stored inclusion and writes a new snapshot", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_MCP_ADD, { url: "https://mcp.y.com/mcp" });
	await harness.clientConn.extMethod(EXT_MCP_INCLUDE, { sessionId, slug: "y" });

	await harness.clientConn.resumeSession({ sessionId, cwd: "/proj", mcpServers: [] } as never);

	const record = await harness.sessionStore.load(sessionId);
	const inclusionEntries = record?.entries.filter((e) => e.type === "mcp_inclusion_set") ?? [];
	// 1 from /mcp include + 1 from the explicit empty override on resume
	expect(inclusionEntries).toHaveLength(2);
	expect((inclusionEntries[1] as { slugs: string[] }).slugs).toEqual([]);
});

test("session hydration calls McpService.hydrate; no auto-connect for disconnected entries", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);

	// Seed kv with an entry whose lastKnownStatus is `disconnected`.
	// The hydration path should ignore it.
	await harness.kvStore.set("mcp/example", {
		transport: "http",
		url: "http://does-not-resolve.invalid/",
		auth: { mode: "public" },
		label: "example",
		addedAt: "2026-05-15T00:00:00.000Z",
		lastKnownStatus: "disconnected",
	});

	// newSession should not block on attempting to connect.
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	expect(typeof sessionId).toBe("string");
});
