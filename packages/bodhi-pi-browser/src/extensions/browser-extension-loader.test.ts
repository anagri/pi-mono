import type { Filesystem } from "@bodhiapp/bodhi-pi";
import { createInMemoryFilesystem } from "@bodhiapp/bodhi-pi";
import { expect, test } from "vitest";
import { createBrowserExtensionLoader } from "./browser-extension-loader.js";

async function seedFs(files: Record<string, string>): Promise<Filesystem> {
	const fs = createInMemoryFilesystem();
	for (const [p, body] of Object.entries(files)) {
		const dir = p.substring(0, p.lastIndexOf("/"));
		if (dir) await fs.mkdir(dir, { recursive: true });
		await fs.writeTextFile(p, body);
	}
	return fs;
}

test("returns empty when extensions dir is missing", async () => {
	const fs = createInMemoryFilesystem();
	const result = await createBrowserExtensionLoader({ filesystem: fs, cwd: "/proj" });
	expect(result).toEqual([]);
});

test("loads a JS extension and exposes the default-export factory", async () => {
	const fs = await seedFs({
		"/proj/.bodhi-pi/extensions/hello.js": `export default function (pi) { /* noop */ };`,
	});
	const result = await createBrowserExtensionLoader({ filesystem: fs, cwd: "/proj" });
	expect(result.map((r) => r.name)).toEqual(["hello"]);
	expect(typeof result[0].factory).toBe("function");
});

test("ignores non-JS files", async () => {
	const fs = await seedFs({
		"/proj/.bodhi-pi/extensions/valid.js": `export default function () {};`,
		"/proj/.bodhi-pi/extensions/README.md": `# notes`,
		"/proj/.bodhi-pi/extensions/skip.ts": `export default function () {};`,
	});
	const result = await createBrowserExtensionLoader({ filesystem: fs, cwd: "/proj" });
	expect(result.map((r) => r.name)).toEqual(["valid"]);
});

test("logs and skips a syntax-error extension; peer extensions still load", async () => {
	const fs = await seedFs({
		"/proj/.bodhi-pi/extensions/broken.js": `this is }} not js;;;`,
		"/proj/.bodhi-pi/extensions/good.js": `export default function () {};`,
	});
	const result = await createBrowserExtensionLoader({ filesystem: fs, cwd: "/proj" });
	expect(result.map((r) => r.name)).toEqual(["good"]);
});

test("logs and skips an extension whose default export is not a function", async () => {
	const fs = await seedFs({
		"/proj/.bodhi-pi/extensions/not-a-fn.js": `export default { not: "a function" };`,
		"/proj/.bodhi-pi/extensions/fine.js": `export default function () {};`,
	});
	const result = await createBrowserExtensionLoader({ filesystem: fs, cwd: "/proj" });
	expect(result.map((r) => r.name)).toEqual(["fine"]);
});
