import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Workspace seed fed into a Node tmpdir. Mirrors the shape used by
 * `bodhi-pi-web/e2e/helpers/seed.ts` so the same content can be written into
 * either an FSA-mounted ZenFS volume or a real Node filesystem with no
 * source-of-truth duplication.
 *
 * Keys in each section are paths relative to the section root. e.g.
 *   commands: { "echo.md": "..." }            → <cwd>/.bodhi-pi/commands/echo.md
 *   skills:   { "say-hello/SKILL.md": "..." } → <cwd>/.bodhi-pi/skills/say-hello/SKILL.md
 *   extensions: { "pirate.js": "..." }        → <cwd>/.bodhi-pi/extensions/pirate.js
 *   files: { "leak.txt": "..." }              → <cwd>/leak.txt
 */
export interface WorkspaceSeed {
	commands?: Record<string, string>;
	skills?: Record<string, string>;
	extensions?: Record<string, string>;
	files?: Record<string, string>;
}

export async function seedWorkspace(cwd: string, seed: WorkspaceSeed): Promise<void> {
	if (seed.commands) await writeUnder(path.join(cwd, ".bodhi-pi", "commands"), seed.commands);
	if (seed.skills) await writeUnder(path.join(cwd, ".bodhi-pi", "skills"), seed.skills);
	if (seed.extensions) await writeUnder(path.join(cwd, ".bodhi-pi", "extensions"), seed.extensions);
	if (seed.files) await writeUnder(cwd, seed.files);
}

async function writeUnder(root: string, files: Record<string, string>): Promise<void> {
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, body, "utf8");
	}
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.resolve(HERE, "..", "fixtures");

/**
 * Read a checked-in fixture file relative to `test/fixtures/`. Used by both
 * cli e2e specs and (via the same path) `bodhi-pi-web` Playwright specs so the
 * literal bytes of every fixture body live in exactly one place on disk.
 *
 * Examples:
 *   loadFixture("commands-echo/.bodhi-pi/commands/echo.md")
 *   loadFixture("skills-say-hello/.bodhi-pi/skills/say-hello/SKILL.md")
 */
export async function loadFixture(relativePath: string): Promise<string> {
	return fs.readFile(path.join(FIXTURES_ROOT, relativePath), "utf8");
}

/** Absolute path to the fixtures root — useful when tests need to point the harness's `cwd` at one. */
export function fixturePath(scenario: string): string {
	return path.join(FIXTURES_ROOT, scenario);
}
