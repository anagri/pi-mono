// ported from packages/bodhi-pi-browser/src/script-executor/browser-script-executor.ts
import type { Filesystem, ScriptExecutor } from "@bodhiapp/bodhi-pi";

const AsyncFunctionCtor = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

function fmt(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function createBrowserScriptExecutor(opts: { filesystem: Filesystem }): ScriptExecutor {
	const { filesystem } = opts;

	return {
		async execute({ scriptPath, args, timeout }) {
			let code: string;
			try {
				code = await filesystem.readTextFile(scriptPath);
			} catch (err) {
				return {
					stdout: "",
					stderr: `read failed: ${(err as Error).message}`,
					exitCode: 1,
				};
			}

			const stdout: string[] = [];
			const stderr: string[] = [];
			const captured = {
				log: (...xs: unknown[]) => stdout.push(xs.map(fmt).join(" ")),
				error: (...xs: unknown[]) => stderr.push(xs.map(fmt).join(" ")),
				warn: (...xs: unknown[]) => stderr.push(xs.map(fmt).join(" ")),
				info: (...xs: unknown[]) => stdout.push(xs.map(fmt).join(" ")),
			};

			let fn: (args: string[], cwd: string, console: typeof captured) => Promise<unknown>;
			try {
				fn = new AsyncFunctionCtor("args", "cwd", "console", code) as typeof fn;
			} catch (err) {
				return {
					stdout: "",
					stderr: `compile failed: ${(err as Error).message}`,
					exitCode: 1,
				};
			}

			const slash = scriptPath.lastIndexOf("/");
			const cwd = slash >= 0 ? scriptPath.slice(0, slash) || "/" : "/";
			const run = fn(args, cwd, captured);

			let timer: ReturnType<typeof setTimeout> | undefined;
			const raced =
				typeof timeout === "number" && timeout > 0
					? Promise.race<unknown>([
							run,
							new Promise<never>((_, reject) => {
								timer = setTimeout(() => reject(new Error(`script timed out after ${timeout}ms`)), timeout);
							}),
						])
					: run;

			try {
				await raced;
				return {
					stdout: stdout.join("\n"),
					stderr: stderr.join("\n"),
					exitCode: 0,
				};
			} catch (err) {
				const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
				const stderrText = [stderr.join("\n"), msg].filter(Boolean).join("\n");
				return { stdout: stdout.join("\n"), stderr: stderrText, exitCode: 1 };
			} finally {
				if (timer !== undefined) clearTimeout(timer);
			}
		},
	};
}
