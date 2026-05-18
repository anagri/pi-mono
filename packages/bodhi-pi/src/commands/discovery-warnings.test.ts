import { describe, expect, test, vi } from "vitest";
import type { BodhiPiLogger } from "@/acp/agent.js";
import { createInMemoryFilesystem } from "@/filesystem/in-memory-filesystem.js";
import { loadProjectCommands } from "./discovery.js";

const CWD = "/proj";
const DIR = "/proj/.bodhi-pi/commands";

function spyLogger(): BodhiPiLogger {
	return { error: vi.fn(), warn: vi.fn() };
}

async function setup(files: Record<string, string>) {
	const fs = createInMemoryFilesystem();
	await fs.mkdir(DIR, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		await fs.writeTextFile(`${DIR}/${name}`, content);
	}
	return fs;
}

describe("loadProjectCommands warnings", () => {
	test("malformed YAML warns with parse-error prefix", async () => {
		const fs = await setup({ "bad.md": "---\ndescription: [unclosed\n---\nbody\n" });
		const logger = spyLogger();
		await loadProjectCommands(fs, CWD, { logger });
		expect(logger.warn).toHaveBeenCalledOnce();
		expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toMatch(
			/^\[bodhi-pi command discovery\] dropped \/proj\/\.bodhi-pi\/commands\/bad\.md: parse error: /,
		);
	});

	test("missing description falls back to first body line (no warning)", async () => {
		const fs = await setup({ "plain.md": "Reply with foo.\n" });
		const logger = spyLogger();
		await loadProjectCommands(fs, CWD, { logger });
		expect(logger.warn).not.toHaveBeenCalled();
	});

	test("healthy project produces zero warnings", async () => {
		const fs = await setup({ "ok.md": "---\ndescription: real\n---\nbody\n" });
		const logger = spyLogger();
		await loadProjectCommands(fs, CWD, { logger });
		expect(logger.warn).not.toHaveBeenCalled();
	});

	test("logger is optional — undefined falls back to console.warn", async () => {
		const fs = await setup({ "bad.md": "---\ndescription: [unclosed\n---\nbody\n" });
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await loadProjectCommands(fs, CWD);
			expect(consoleWarn).toHaveBeenCalledOnce();
			expect(consoleWarn.mock.calls[0]?.[0]).toMatch(
				/^\[bodhi-pi command discovery\] dropped \/proj\/\.bodhi-pi\/commands\/bad\.md: parse error: /,
			);
		} finally {
			consoleWarn.mockRestore();
		}
	});
});
