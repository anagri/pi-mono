import type { Filesystem } from "@/index.js";

export async function seedCommand(fs: Filesystem, cwd: string, name: string, content: string): Promise<void> {
	const dir = `${cwd === "/" ? "" : cwd}/.bodhi-pi/commands`;
	await fs.mkdir(dir, { recursive: true });
	await fs.writeTextFile(`${dir}/${name}`, content);
}

export async function seedSkill(fs: Filesystem, cwd: string, folder: string, content: string): Promise<void> {
	const dir = `${cwd === "/" ? "" : cwd}/.bodhi-pi/skills/${folder}`;
	await fs.mkdir(dir, { recursive: true });
	await fs.writeTextFile(`${dir}/SKILL.md`, content);
}

export async function seedContextFile(fs: Filesystem, dir: string, filename: string, content: string): Promise<void> {
	const normalized = dir === "/" ? "" : dir;
	await fs.mkdir(dir, { recursive: true });
	await fs.writeTextFile(`${normalized}/${filename}`, content);
}

export async function seedProjectSettings(fs: Filesystem, cwd: string, content: string): Promise<void> {
	const dir = `${cwd === "/" ? "" : cwd}/.bodhi-pi`;
	await fs.mkdir(dir, { recursive: true });
	await fs.writeTextFile(`${dir}/settings.json`, content);
}
