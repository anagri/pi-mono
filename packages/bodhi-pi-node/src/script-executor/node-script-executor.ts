import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ScriptExecuteParams, ScriptExecuteResult, ScriptExecutor } from "@bodhiapp/bodhi-pi";

export function createNodeScriptExecutor(): ScriptExecutor {
	return {
		async execute({ scriptPath, cwd, args, timeout }: ScriptExecuteParams): Promise<ScriptExecuteResult> {
			let code: string;
			try {
				code = await readFile(scriptPath, "utf-8");
			} catch (err) {
				return { stdout: "", stderr: `read failed: ${(err as Error).message}`, exitCode: 1 };
			}

			const wrapped = `const args = ${JSON.stringify(args)};\n${code}`;

			return new Promise((resolve) => {
				const child = spawn("node", [], { cwd, stdio: ["pipe", "pipe", "pipe"] });

				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				let settled = false;

				child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
				child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

				const settle = (result: ScriptExecuteResult) => {
					if (settled) return;
					settled = true;
					if (timer !== undefined) clearTimeout(timer);
					resolve(result);
				};

				let timer: ReturnType<typeof setTimeout> | undefined;
				if (timeout !== undefined) {
					timer = setTimeout(() => {
						child.kill("SIGTERM");
						settle({
							stdout: Buffer.concat(stdout).toString("utf-8"),
							stderr: `timed out after ${timeout}ms`,
							exitCode: 1,
						});
					}, timeout);
				}

				// Spawn failure (`node` not in PATH, sandbox denial, OOM at fork). Without
				// this handler the promise would never resolve — the agent would hang.
				child.on("error", (err) => {
					settle({
						stdout: "",
						stderr: `spawn failed: ${err.message}`,
						exitCode: 1,
					});
				});

				// EPIPE if the child exits before consuming stdin (syntax error in the
				// wrapped script, missing node, etc.). Swallow on stdin so the failure
				// surfaces via the `close` / `error` event instead of crashing the host.
				child.stdin.on("error", () => {});

				child.on("close", (code) => {
					settle({
						stdout: Buffer.concat(stdout).toString("utf-8"),
						stderr: Buffer.concat(stderr).toString("utf-8"),
						exitCode: code ?? 1,
					});
				});

				try {
					child.stdin.write(wrapped, "utf-8");
					child.stdin.end();
				} catch (err) {
					settle({
						stdout: "",
						stderr: `stdin write failed: ${(err as Error).message}`,
						exitCode: 1,
					});
				}
			});
		},
	};
}
