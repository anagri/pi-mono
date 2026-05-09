import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Strip a leading `---\n…\n---\n` YAML block. Throws on malformed YAML so callers
 * can choose to skip the file. Absence of the block is not an error — the whole
 * input becomes the body and the frontmatter is an empty object.
 *
 * Non-object payloads (YAML `null`, scalars, arrays) are silently coerced to an
 * empty frontmatter object — the body is preserved. This matches the convention
 * that `---\n---` (empty block) and `---\nnull\n---` are both "no frontmatter,
 * here is the body". Callers needing strict shape validation should narrow on the
 * returned `T` themselves.
 */
export function parseFrontmatter<T extends object>(raw: string): { frontmatter: T; body: string } {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) return { frontmatter: {} as T, body: raw };
	const parsed = parseYaml(match[1]);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { frontmatter: {} as T, body: match[2] };
	return { frontmatter: parsed as T, body: match[2] };
}
