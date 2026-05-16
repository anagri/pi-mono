import { type ChildProcess, spawn } from "node:child_process";

/** Wait for `child.stdout` / `child.stderr` to emit a chunk matching `pattern`. */
export function waitForListening(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error(`child did not bind within ${timeoutMs}ms`)), timeoutMs);
		const onData = (chunk: Buffer | string) => {
			buf += chunk.toString();
			if (pattern.test(buf)) {
				clearTimeout(timer);
				child.stdout?.off("data", onData);
				child.stderr?.off("data", onData);
				resolve();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`child exited before binding (code=${code}); buf=${buf.slice(0, 200)}`));
		});
	});
}

/**
 * Spawn `@modelcontextprotocol/server-everything streamableHttp` on the given port.
 * Caller owns the returned child and must `kill` it on teardown. Stdio is drained
 * post-bind so the child doesn't block on backpressure for the rest of the run.
 */
export async function spawnMcpEverythingHttp(port: number, timeoutMs = 30_000): Promise<ChildProcess> {
	const child = spawn("npx", ["--yes", "@modelcontextprotocol/server-everything", "streamableHttp"], {
		env: { ...process.env, PORT: String(port), FORCE_COLOR: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitForListening(child, /listening on port/i, timeoutMs);
	child.stdout?.on("data", () => {});
	child.stderr?.on("data", () => {});
	return child;
}
