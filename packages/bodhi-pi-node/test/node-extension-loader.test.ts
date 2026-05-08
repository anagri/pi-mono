import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createNodeExtensionLoader } from "@/extensions/node-extension-loader.js";

let tmpDir: string;
let extDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-node-ext-"));
	extDir = path.join(tmpDir, ".bodhi-pi", "extensions");
	await fs.mkdir(extDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

test("returns empty array when extensions dir is missing", async () => {
	const cleanCwd = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-node-empty-"));
	try {
		const result = await createNodeExtensionLoader({ cwd: cleanCwd });
		expect(result).toEqual([]);
	} finally {
		await fs.rm(cleanCwd, { recursive: true, force: true });
	}
});

test("loads a TypeScript extension via jiti and exposes the default-export factory", async () => {
	await fs.writeFile(
		path.join(extDir, "valid-ts.ts"),
		`export default function (pi) { pi.registerCommand("hello", { description: "hi", template: "say hi" }); }`,
	);

	const result = await createNodeExtensionLoader({ cwd: tmpDir });
	expect(result).toHaveLength(1);
	expect(result[0].name).toBe("valid-ts");
	expect(typeof result[0].factory).toBe("function");
});

test("loads a JavaScript extension and ignores unrelated file extensions", async () => {
	await fs.writeFile(path.join(extDir, "valid.js"), `export default function (pi) { /* noop */ }`);
	await fs.writeFile(path.join(extDir, "README.md"), "not an extension");
	await fs.writeFile(path.join(extDir, "config.json"), "{}");

	const result = await createNodeExtensionLoader({ cwd: tmpDir });
	expect(result.map((r) => r.name)).toEqual(["valid"]);
});

test("logs and skips a syntax-error extension; peer extensions still load", async () => {
	await fs.writeFile(path.join(extDir, "broken.ts"), `this is not valid typescript {{{`);
	await fs.writeFile(path.join(extDir, "good.ts"), `export default function (pi) { /* noop */ }`);
	const result = await createNodeExtensionLoader({ cwd: tmpDir });
	expect(result.map((r) => r.name)).toEqual(["good"]);
});

test("logs and skips an extension whose default export is not a function", async () => {
	await fs.writeFile(path.join(extDir, "not-a-fn.ts"), `export default { not: "a function" };`);
	await fs.writeFile(path.join(extDir, "fine.ts"), `export default function (pi) { /* noop */ }`);
	const result = await createNodeExtensionLoader({ cwd: tmpDir });
	expect(result.map((r) => r.name)).toEqual(["fine"]);
});
