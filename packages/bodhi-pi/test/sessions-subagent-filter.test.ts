import { expect, test } from "vitest";
import { createInMemorySessionStore } from "@/index.js";

test("create({subagent}) persists subagent and parentSessionId fields", async () => {
	const store = createInMemorySessionStore();
	const parent = await store.create({ cwd: "/proj" });
	const child = await store.create({
		cwd: "/proj",
		parentSessionId: parent.id,
		subagent: { profileName: "extractor" },
	});

	expect(child.parentSessionId).toBe(parent.id);
	expect(child.subagent).toEqual({ profileName: "extractor" });

	const loaded = await store.load(child.id);
	expect(loaded?.parentSessionId).toBe(parent.id);
	expect(loaded?.subagent).toEqual({ profileName: "extractor" });
});

test("list excludes subagent children by default", async () => {
	const store = createInMemorySessionStore();
	const parent = await store.create({ cwd: "/proj" });
	await store.create({ cwd: "/proj", parentSessionId: parent.id, subagent: { profileName: "extractor" } });

	const result = await store.list({});
	const ids = result.sessions.map((s) => s.sessionId);
	expect(ids).toContain(parent.id);
	expect(ids).toHaveLength(1);
});

test("list includes subagent children when includeSubagentChildren: true", async () => {
	const store = createInMemorySessionStore();
	const parent = await store.create({ cwd: "/proj" });
	const child = await store.create({
		cwd: "/proj",
		parentSessionId: parent.id,
		subagent: { profileName: "extractor" },
	});

	const result = await store.list({ includeSubagentChildren: true });
	const ids = result.sessions.map((s) => s.sessionId);
	expect(ids).toContain(parent.id);
	expect(ids).toContain(child.id);
});

test("list filters by parentSessionId", async () => {
	const store = createInMemorySessionStore();
	const parentA = await store.create({ cwd: "/proj" });
	const parentB = await store.create({ cwd: "/proj" });
	const childA = await store.create({
		cwd: "/proj",
		parentSessionId: parentA.id,
		subagent: { profileName: "extractor" },
	});
	await store.create({
		cwd: "/proj",
		parentSessionId: parentB.id,
		subagent: { profileName: "extractor" },
	});

	const result = await store.list({ parentSessionId: parentA.id, includeSubagentChildren: true });
	const ids = result.sessions.map((s) => s.sessionId);
	expect(ids).toEqual([childA.id]);
});

test("forks are visible in default list (not filtered as subagent children)", async () => {
	const store = createInMemorySessionStore();
	const source = await store.create({ cwd: "/proj" });
	await store.append(source.id, { id: "e1", type: "session_info", name: "anchor", timestamp: Date.now() } as never);
	const { newSessionId: forkId } = await store.forkRecord(source.id, "e1", "at");

	const result = await store.list({});
	const ids = result.sessions.map((s) => s.sessionId);
	expect(ids).toContain(source.id);
	expect(ids).toContain(forkId);
});
