import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Terminal, TerminalExecInput, TerminalExecResult } from "@bodhiapp/bodhi-pi";

const DEFAULT_OUTPUT_BYTE_LIMIT = 256 * 1024;
const KILL_GRACE_MS = 1000;

interface BoundedBuffer {
	chunks: Buffer[];
	size: number;
	truncated: boolean;
}

function appendBounded(buf: BoundedBuffer, chunk: Buffer, limit: number): void {
	if (buf.truncated) return;
	const remaining = limit - buf.size;
	if (chunk.length <= remaining) {
		buf.chunks.push(chunk);
		buf.size += chunk.length;
		return;
	}
	if (remaining > 0) {
		buf.chunks.push(chunk.subarray(0, remaining));
		buf.size += remaining;
	}
	buf.truncated = true;
}

function bufferToString(buf: BoundedBuffer): string {
	return Buffer.concat(buf.chunks).toString("utf-8");
}

/**
 * Spawn-backed `Terminal` for the cli test-app. Runs `bash -c <command>` in a
 * child process with timeout + external-signal cancellation, captures stdout
 * and stderr separately, and truncates each stream at `outputByteLimit`.
 */
export function createBashTerminal(): Terminal {
	return {
		capabilities: {
			cwd: true,
			env: true,
			stdin: true,
			timeout: true,
			cancel: true,
			separateStreams: true,
		},
		async exec(input: TerminalExecInput): Promise<TerminalExecResult> {
			const limit = input.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT;
			const startedAt = Date.now();
			const child: ChildProcessWithoutNullStreams = spawn("bash", ["-c", input.command], {
				...(input.cwd ? { cwd: input.cwd } : {}),
				env: { ...process.env, ...(input.env ?? {}) },
				stdio: ["pipe", "pipe", "pipe"],
			});

			const stdout: BoundedBuffer = { chunks: [], size: 0, truncated: false };
			const stderr: BoundedBuffer = { chunks: [], size: 0, truncated: false };
			let timedOut = false;
			let cancelled = false;
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let externalAbortListener: (() => void) | undefined;

			child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, limit));
			child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, limit));

			const killChild = (reason: "timeout" | "cancel"): void => {
				if (reason === "timeout") timedOut = true;
				else cancelled = true;
				try {
					child.kill("SIGTERM");
				} catch {
					// child may already be dead — close handler will still fire.
				}
				killTimer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// ignore
					}
				}, KILL_GRACE_MS);
			};

			if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
				timeoutTimer = setTimeout(() => killChild("timeout"), input.timeoutMs);
			}
			if (input.signal) {
				if (input.signal.aborted) {
					killChild("cancel");
				} else {
					externalAbortListener = () => killChild("cancel");
					input.signal.addEventListener("abort", externalAbortListener, { once: true });
				}
			}

			// EPIPE if the child exits before consuming stdin — swallow so the
			// failure surfaces via close/error instead of crashing the host.
			child.stdin.on("error", () => {});
			if (input.stdin !== undefined) {
				try {
					child.stdin.write(input.stdin, "utf-8");
				} catch {
					// swallow — handled by stdin error listener above
				}
			}
			child.stdin.end();

			return new Promise<TerminalExecResult>((resolve) => {
				let settled = false;
				const settle = (result: TerminalExecResult) => {
					if (settled) return;
					settled = true;
					if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
					if (killTimer !== undefined) clearTimeout(killTimer);
					if (externalAbortListener && input.signal) {
						input.signal.removeEventListener("abort", externalAbortListener);
					}
					resolve(result);
				};

				child.on("error", (err) => {
					settle({
						stdout: bufferToString(stdout),
						stderr: `spawn failed: ${err.message}`,
						exitCode: 1,
						signal: null,
						durationMs: Date.now() - startedAt,
						timedOut,
						truncated: stdout.truncated || stderr.truncated,
					});
				});

				child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
					settle({
						stdout: bufferToString(stdout),
						stderr: bufferToString(stderr),
						exitCode: code,
						signal: signal ?? (timedOut || cancelled ? "SIGTERM" : null),
						durationMs: Date.now() - startedAt,
						timedOut,
						truncated: stdout.truncated || stderr.truncated,
					});
				});
			});
		},
	};
}
