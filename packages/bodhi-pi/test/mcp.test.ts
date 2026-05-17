import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createBodhiPiClient } from "@/client/client.js";
import type { BodhiPiAcpConnection } from "@/client/types.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness, type TestHarness } from "./helpers/harness.js";

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

function bindClient(harness: TestHarness) {
	return createBodhiPiClient(harness.clientConn as unknown as BodhiPiAcpConnection);
}

test("/mcp add with a url stores an entry under mcp/<slug> and returns the slug", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	const result = await client.mcpAdd({ url: "https://mcp.github.com/mcp" });
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

test("/mcp add collides cleanly with a random suffix on second add of the same url", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	const first = await client.mcpAdd({ url: "https://mcp.github.com/mcp" });
	const second = await client.mcpAdd({ url: "https://mcp.github.com/mcp" });
	expect(first.slug).toBe("github");
	expect(second.slug).toMatch(/^github-[0-9a-f]{5}$/);
});

test("/mcp list exposes (slug, label, status, transport, url) for added entries", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await client.mcpAdd({ url: "https://mcp.example.com/mcp", label: "Example" });

	const entries = await client.mcpList();
	expect(entries).toEqual([
		{
			slug: "example",
			label: "Example",
			status: "disconnected",
			transport: "http",
			url: "https://mcp.example.com/mcp",
		},
	]);
});

test("/mcp remove drops the kv entry", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await client.mcpAdd({ url: "https://mcp.foo.com/mcp" });
	await client.mcpRemove({ slug: "foo" });

	const remaining = await client.kv.list({ prefix: "mcp/" });
	expect(remaining.entries).toEqual([]);
});

test("/mcp add persists stdio entries when the host supports them", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	const result = await client.mcpAdd({
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-everything", "stdio"],
	});
	expect(result.slug).toBe("server-everything");
	const stored = await harness.kvStore.get(`mcp/${result.slug}`);
	expect(stored).toMatchObject({ transport: "stdio", command: "npx" });
});

test("/mcp add rejects stdio commands when supportsMcpStdio=false", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, supportsMcpStdio: false });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await expect(client.mcpAdd({ command: "npx", args: ["@modelcontextprotocol/server-everything"] })).rejects.toThrow(
		/stdio MCPs are not supported/,
	);
});

test("/mcp include writes an mcp_inclusion_set session entry; /mcp exclude writes a new snapshot", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	const { sessionId } = await client.newSession({ cwd: "/proj" });

	// Add two MCP entries (don't need to connect; include() doesn't auto-connect).
	await client.mcpAdd({ url: "https://mcp.a.com/mcp" });
	await client.mcpAdd({ url: "https://mcp.b.com/mcp" });

	await client.mcpInclude({ sessionId, slug: "a" });
	let record = await harness.sessionStore.load(sessionId);
	const inclusionEntriesAfterA = record?.entries.filter((e) => e.type === "mcp_inclusion_set") ?? [];
	expect(inclusionEntriesAfterA).toHaveLength(1);
	expect((inclusionEntriesAfterA[0] as { slugs: string[] }).slugs).toEqual(["a"]);

	await client.mcpInclude({ sessionId, slug: "b" });
	record = await harness.sessionStore.load(sessionId);
	const inclusionEntriesAfterB = record?.entries.filter((e) => e.type === "mcp_inclusion_set") ?? [];
	expect(inclusionEntriesAfterB).toHaveLength(2);
	expect((inclusionEntriesAfterB[1] as { slugs: string[] }).slugs).toEqual(["a", "b"]);

	await client.mcpExclude({ sessionId, slug: "a" });
	record = await harness.sessionStore.load(sessionId);
	const inclusionEntriesAfterExclude = record?.entries.filter((e) => e.type === "mcp_inclusion_set") ?? [];
	expect(inclusionEntriesAfterExclude).toHaveLength(3);
	expect((inclusionEntriesAfterExclude[2] as { slugs: string[] }).slugs).toEqual(["b"]);
});

test("session/resume restores inclusion from the last mcp_inclusion_set entry when mcpServers is omitted", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	const { sessionId } = await client.newSession({ cwd: "/proj" });

	await client.mcpAdd({ url: "https://mcp.x.com/mcp" });
	await client.mcpInclude({ sessionId, slug: "x" });

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
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	const { sessionId } = await client.newSession({ cwd: "/proj" });

	await client.mcpAdd({ url: "https://mcp.y.com/mcp" });
	await client.mcpInclude({ sessionId, slug: "y" });

	await client.resumeSession({ sessionId, cwd: "/proj", mcpServers: [] });

	const record = await harness.sessionStore.load(sessionId);
	const inclusionEntries = record?.entries.filter((e) => e.type === "mcp_inclusion_set") ?? [];
	// 1 from /mcp include + 1 from the explicit empty override on resume
	expect(inclusionEntries).toHaveLength(2);
	expect((inclusionEntries[1] as { slugs: string[] }).slugs).toEqual([]);
});

test("session hydration calls McpService.hydrate; no auto-connect for disconnected entries", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);

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
	const { sessionId } = await client.newSession({ cwd: "/proj" });
	expect(typeof sessionId).toBe("string");
});

test("hydrate surfaces unknown slugs via _meta and mcp_status_change error events", async () => {
	const model = newFaux();
	const events: import("@/index.js").BodhiPiEvent[] = [];
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		eventHandlers: {
			mcp_status_change: [(e) => void events.push(e)],
		},
	});
	const client = bindClient(harness);
	await client.initialize(stdInitParams);

	// Seed one known entry; request hydration referencing one known + two unknown slugs.
	await harness.kvStore.set("mcp/known", {
		transport: "http",
		url: "https://mcp.known.example/mcp",
		auth: { mode: "public" },
		label: "known",
		addedAt: "2026-05-17T00:00:00.000Z",
		lastKnownStatus: "disconnected",
	});

	const result = await client.newSession({
		cwd: "/proj",
		mcpServers: [
			{ name: "known", type: "http", url: "https://mcp.known.example/mcp", headers: [] },
			{ name: "ghost-a", type: "http", url: "https://nope.example/a", headers: [] },
			{ name: "ghost-b", type: "http", url: "https://nope.example/b", headers: [] },
		],
	});

	const meta = result._meta as { "bodhi-pi"?: { mcp?: { notFoundSlugs?: string[] } } } | undefined;
	expect(meta?.["bodhi-pi"]?.mcp?.notFoundSlugs).toEqual(["ghost-a", "ghost-b"]);

	const errorEvents = events.filter((e) => e.type === "mcp_status_change" && e.status === "error");
	expect(errorEvents.map((e) => (e as { slug: string }).slug)).toEqual(["ghost-a", "ghost-b"]);
	for (const e of errorEvents) {
		expect((e as { errorMessage?: string }).errorMessage).toBe("unknown slug");
	}
});
