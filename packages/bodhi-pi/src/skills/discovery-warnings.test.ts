import { describe, expect, test, vi } from "vitest";
import type { BodhiPiLogger } from "@/acp/agent.js";
import { createInMemoryFilesystem } from "@/filesystem/in-memory-filesystem.js";
import { loadProjectSkills } from "./discovery.js";

const CWD = "/proj";
const SKILLS = "/proj/.bodhi-pi/skills";

function spyLogger(): BodhiPiLogger {
	return { error: vi.fn(), warn: vi.fn() };
}

async function seedSkillFile(path: string, content: string) {
	const fs = createInMemoryFilesystem();
	const dir = path.substring(0, path.lastIndexOf("/"));
	await fs.mkdir(dir, { recursive: true });
	await fs.writeTextFile(path, content);
	return fs;
}

describe("loadProjectSkills warnings", () => {
	test("malformed YAML warns with parse-error prefix", async () => {
		const fs = await seedSkillFile(`${SKILLS}/bad/SKILL.md`, "---\ndescription: [unclosed\n---\nbody\n");
		const logger = spyLogger();
		await loadProjectSkills(fs, CWD, { logger });
		expect(logger.warn).toHaveBeenCalledOnce();
		expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toMatch(
			/^\[bodhi-pi skill discovery\] dropped \/proj\/\.bodhi-pi\/skills\/bad\/SKILL\.md: parse error: /,
		);
	});

	test("missing description warns with reason", async () => {
		const fs = await seedSkillFile(`${SKILLS}/nodesc/SKILL.md`, "---\nname: nodesc\n---\nbody\n");
		const logger = spyLogger();
		await loadProjectSkills(fs, CWD, { logger });
		expect(logger.warn).toHaveBeenCalledWith(
			"[bodhi-pi skill discovery] dropped /proj/.bodhi-pi/skills/nodesc/SKILL.md: missing description",
		);
	});

	test("description over 1024 chars warns with reason", async () => {
		const longDesc = "x".repeat(1025);
		const fs = await seedSkillFile(`${SKILLS}/long/SKILL.md`, `---\ndescription: ${longDesc}\n---\nbody\n`);
		const logger = spyLogger();
		await loadProjectSkills(fs, CWD, { logger });
		expect(logger.warn).toHaveBeenCalledWith(
			"[bodhi-pi skill discovery] dropped /proj/.bodhi-pi/skills/long/SKILL.md: description exceeds 1024 chars",
		);
	});

	test("invalid name warns with quoted name", async () => {
		const fs = await seedSkillFile(
			`${SKILLS}/bad-skill/SKILL.md`,
			"---\nname: bad Name!\ndescription: x\n---\nbody\n",
		);
		const logger = spyLogger();
		await loadProjectSkills(fs, CWD, { logger });
		expect(logger.warn).toHaveBeenCalledWith(
			'[bodhi-pi skill discovery] dropped /proj/.bodhi-pi/skills/bad-skill/SKILL.md: invalid name "bad Name!"',
		);
	});

	test("healthy project produces zero warnings", async () => {
		const fs = await seedSkillFile(`${SKILLS}/ok/SKILL.md`, "---\ndescription: real\n---\nbody\n");
		const logger = spyLogger();
		await loadProjectSkills(fs, CWD, { logger });
		expect(logger.warn).not.toHaveBeenCalled();
	});

	test("folders without SKILL.md are silently ignored (not warned)", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir(`${SKILLS}/notes`, { recursive: true });
		const logger = spyLogger();
		await loadProjectSkills(fs, CWD, { logger });
		expect(logger.warn).not.toHaveBeenCalled();
	});

	test("logger is optional — undefined falls back to console.warn", async () => {
		const fs = await seedSkillFile(`${SKILLS}/nodesc/SKILL.md`, "---\nname: nodesc\n---\nbody\n");
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await loadProjectSkills(fs, CWD);
			expect(consoleWarn).toHaveBeenCalledWith(
				"[bodhi-pi skill discovery] dropped /proj/.bodhi-pi/skills/nodesc/SKILL.md: missing description",
			);
		} finally {
			consoleWarn.mockRestore();
		}
	});
});
