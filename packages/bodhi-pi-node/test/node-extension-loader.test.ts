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

test("loads a JS extension and exposes the default-export factory", async () => {
	await fs.writeFile(
		path.join(extDir, "valid.js"),
		`export default function (pi) { pi.registerCommand("hello", { description: "hi", template: "say hi" }); }`,
	);

	const result = await createNodeExtensionLoader({ cwd: tmpDir });
	expect(result).toHaveLength(1);
	expect(result[0].name).toBe("valid");
	expect(typeof result[0].factory).toBe("function");
});

test("loads .mjs and .cjs alongside .js; ignores unrelated file extensions", async () => {
	await fs.writeFile(path.join(extDir, "a.js"), `export default function (pi) { /* noop */ }`);
	await fs.writeFile(path.join(extDir, "b.mjs"), `export default function (pi) { /* noop */ }`);
	await fs.writeFile(path.join(extDir, "c.cjs"), `module.exports = function (pi) { /* noop */ };`);
	await fs.writeFile(path.join(extDir, "README.md"), "not an extension");
	await fs.writeFile(path.join(extDir, "config.json"), "{}");

	const result = await createNodeExtensionLoader({ cwd: tmpDir });
	expect(result.map((r) => r.name)).toEqual(["a", "b", "c"]);
});

test("ignores .ts/.tsx files (charter: extensions are standalone JS only)", async () => {
	// Per ai-docs/plans/skipped.md: TS extensions stay out so the same source
	// runs identically under Node and browser runtimes — no transpiler at runtime.
	await fs.writeFile(path.join(extDir, "ts-thing.ts"), `export default function (pi) { /* noop */ }`);
	await fs.writeFile(path.join(extDir, "tsx-thing.tsx"), `export default function (pi) { /* noop */ }`);
	await fs.writeFile(path.join(extDir, "real.js"), `export default function (pi) { /* noop */ }`);

	const result = await createNodeExtensionLoader({ cwd: tmpDir });
	expect(result.map((r) => r.name)).toEqual(["real"]);
});

test("logs and skips a syntax-error extension; peer extensions still load", async () => {
	await fs.writeFile(path.join(extDir, "broken.mjs"), `this is not valid javascript {{{`);
	await fs.writeFile(path.join(extDir, "good.js"), `export default function (pi) { /* noop */ }`);
	const result = await createNodeExtensionLoader({ cwd: tmpDir });
	expect(result.map((r) => r.name)).toEqual(["good"]);
});

test("logs and skips an extension whose default export is not a function", async () => {
	await fs.writeFile(path.join(extDir, "not-a-fn.js"), `export default { not: "a function" };`);
	await fs.writeFile(path.join(extDir, "fine.js"), `export default function (pi) { /* noop */ }`);
	const result = await createNodeExtensionLoader({ cwd: tmpDir });
	expect(result.map((r) => r.name)).toEqual(["fine"]);
});
