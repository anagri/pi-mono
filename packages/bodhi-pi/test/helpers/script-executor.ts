import type { Filesystem, ScriptExecutor } from "../../src/index.js";

/**
 * Reference test executor — non-sandboxed. Reads the script via the test
 * `Filesystem`, runs it via `new Function` with `args` and a captured
 * `console`. Suitable for the in-test trust model only. Real hosts choose
 * their own isolation strategy (vm, worker, quickjs-emscripten, etc.).
 */
export function createTestScriptExecutor(fs: Filesystem): ScriptExecutor {
	return {
		async execute({ scriptPath, args }) {
			let code: string;
			try {
				code = await fs.readTextFile(scriptPath);
			} catch (err) {
				return { stdout: "", stderr: `read failed: ${(err as Error).message}`, exitCode: 1 };
			}
			const stdout: string[] = [];
			const stderr: string[] = [];
			const captured = {
				log: (...xs: unknown[]) => stdout.push(xs.map(String).join(" ")),
				error: (...xs: unknown[]) => stderr.push(xs.map(String).join(" ")),
			};
			try {
				new Function("args", "console", code)(args, captured);
				return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode: 0 };
			} catch (err) {
				return { stdout: stdout.join("\n"), stderr: String(err), exitCode: 1 };
			}
		},
	};
}
