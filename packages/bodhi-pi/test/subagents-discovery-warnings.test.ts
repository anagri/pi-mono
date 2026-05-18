import { expect, test, vi } from "vitest";
import type { BodhiPiLogger } from "@/acp/agent.js";
import { createInMemoryFilesystem } from "@/index.js";
import { loadProjectSubagents } from "@/subagents/discovery.js";
import { seedSubagent } from "./helpers/filesystem.js";

function spyLogger(): BodhiPiLogger {
	return { error: vi.fn(), warn: vi.fn() };
}

test("malformed YAML warns with parse-error prefix", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "bad", "---\ndescription: [unclosed\n---\nbody\n");
	const logger = spyLogger();
	const profiles = await loadProjectSubagents(fs, "/proj", { logger });
	expect(profiles).toEqual([]);
	expect(logger.warn).toHaveBeenCalledOnce();
	expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toMatch(
		/^\[bodhi-pi subagent discovery\] dropped \/proj\/\.bodhi-pi\/agents\/bad\.md: parse error: /,
	);
});

test("missing description warns with reason", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "nodesc", "---\nname: nodesc\n---\nbody\n");
	const logger = spyLogger();
	await loadProjectSubagents(fs, "/proj", { logger });
	expect(logger.warn).toHaveBeenCalledWith(
		"[bodhi-pi subagent discovery] dropped /proj/.bodhi-pi/agents/nodesc.md: missing description",
	);
});

test("description over 1024 chars warns with reason", async () => {
	const fs = createInMemoryFilesystem();
	const longDesc = "x".repeat(1025);
	await seedSubagent(fs, "/proj", "longdesc", `---\ndescription: ${longDesc}\n---\nbody\n`);
	const logger = spyLogger();
	await loadProjectSubagents(fs, "/proj", { logger });
	expect(logger.warn).toHaveBeenCalledWith(
		"[bodhi-pi subagent discovery] dropped /proj/.bodhi-pi/agents/longdesc.md: description exceeds 1024 chars",
	);
});

test("invalid name warns with quoted name", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "Bad_Name", "---\ndescription: x\n---\nbody\n");
	const logger = spyLogger();
	await loadProjectSubagents(fs, "/proj", { logger });
	expect(logger.warn).toHaveBeenCalledWith(
		'[bodhi-pi subagent discovery] dropped /proj/.bodhi-pi/agents/Bad_Name.md: invalid name "Bad_Name"',
	);
});

test("empty body warns with reason", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "empty", "---\nname: empty\ndescription: desc\n---\n\n");
	const logger = spyLogger();
	await loadProjectSubagents(fs, "/proj", { logger });
	expect(logger.warn).toHaveBeenCalledWith(
		"[bodhi-pi subagent discovery] dropped /proj/.bodhi-pi/agents/empty.md: empty body",
	);
});

test("invalid context warns with quoted value", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "weird", "---\ndescription: bad\ncontext: cosmic\n---\nbody\n");
	const logger = spyLogger();
	await loadProjectSubagents(fs, "/proj", { logger });
	expect(logger.warn).toHaveBeenCalledWith(
		'[bodhi-pi subagent discovery] dropped /proj/.bodhi-pi/agents/weird.md: invalid context "cosmic"',
	);
});

test("duplicate names warn but first wins", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "alpha", "---\nname: shared\ndescription: a\n---\nbody\n");
	await seedSubagent(fs, "/proj", "beta", "---\nname: shared\ndescription: b\n---\nbody\n");
	const logger = spyLogger();
	const profiles = await loadProjectSubagents(fs, "/proj", { logger });
	expect(profiles.map((p) => p.name)).toEqual(["shared"]);
	expect(logger.warn).toHaveBeenCalledWith(
		'[bodhi-pi subagent discovery] dropped /proj/.bodhi-pi/agents/beta.md: duplicate name "shared"',
	);
});

test("healthy project produces zero warnings", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "ok", "---\ndescription: real\n---\nbody\n");
	const logger = spyLogger();
	await loadProjectSubagents(fs, "/proj", { logger });
	expect(logger.warn).not.toHaveBeenCalled();
});

test("logger is optional — undefined falls back to console.warn", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "bad", "---\nname: bad\n---\nbody\n");
	const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		await loadProjectSubagents(fs, "/proj");
		expect(consoleWarn).toHaveBeenCalledWith(
			"[bodhi-pi subagent discovery] dropped /proj/.bodhi-pi/agents/bad.md: missing description",
		);
	} finally {
		consoleWarn.mockRestore();
	}
});
