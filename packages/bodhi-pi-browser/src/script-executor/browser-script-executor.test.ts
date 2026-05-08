import "fake-indexeddb/auto";
import type { Filesystem } from "@bodhiapp/bodhi-pi";
import { describe, expect, test } from "vitest";
import { createBrowserScriptExecutor } from "./browser-script-executor.js";

function memoryFs(files: Record<string, string>): Filesystem {
	return {
		async readTextFile(p) {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p] ?? "";
		},
		async writeTextFile() {
			throw new Error("not implemented");
		},
		async list() {
			throw new Error("not implemented");
		},
		async stat() {
			throw new Error("not implemented");
		},
		async exists(p) {
			return p in files;
		},
		async mkdir() {
			throw new Error("not implemented");
		},
		async remove() {
			throw new Error("not implemented");
		},
	};
}

describe("createBrowserScriptExecutor", () => {
	test("happy path: script logs and returns exit 0", async () => {
		const exec = createBrowserScriptExecutor({
			filesystem: memoryFs({ "/foo/script.js": "console.log('hello', args[0]);" }),
		});
		const result = await exec.execute({ scriptPath: "/foo/script.js", cwd: "/", args: ["world"] });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello world");
		expect(result.stderr).toBe("");
	});

	test("script throws → exit 1, error in stderr", async () => {
		const exec = createBrowserScriptExecutor({
			filesystem: memoryFs({ "/x.js": "throw new Error('boom');" }),
		});
		const result = await exec.execute({ scriptPath: "/x.js", cwd: "/", args: [] });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/boom/);
	});

	test("missing script file → exit 1", async () => {
		const exec = createBrowserScriptExecutor({ filesystem: memoryFs({}) });
		const result = await exec.execute({ scriptPath: "/nope.js", cwd: "/", args: [] });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/read failed/);
	});

	test("timeout interrupts a hung script", async () => {
		const exec = createBrowserScriptExecutor({
			filesystem: memoryFs({ "/slow.js": "await new Promise(r => setTimeout(r, 10_000));" }),
		});
		const result = await exec.execute({ scriptPath: "/slow.js", cwd: "/", args: [], timeout: 50 });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/timed out/);
	});

	test("cwd derived from scriptPath is in scope", async () => {
		const exec = createBrowserScriptExecutor({
			filesystem: memoryFs({ "/dir/x.js": "console.log(cwd);" }),
		});
		const result = await exec.execute({ scriptPath: "/dir/x.js", cwd: "/", args: [] });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("/dir");
	});

	test("async script returning a value succeeds", async () => {
		const exec = createBrowserScriptExecutor({
			filesystem: memoryFs({ "/a.js": "console.log('a'); await Promise.resolve(); console.log('b');" }),
		});
		const result = await exec.execute({ scriptPath: "/a.js", cwd: "/", args: [] });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("a");
		expect(result.stdout).toContain("b");
	});

	test("syntax error → exit 1 with compile failed", async () => {
		const exec = createBrowserScriptExecutor({
			filesystem: memoryFs({ "/bad.js": "this is not valid js {{" }),
		});
		const result = await exec.execute({ scriptPath: "/bad.js", cwd: "/", args: [] });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/compile failed/);
	});
});
