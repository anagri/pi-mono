import type { Filesystem, Terminal, TerminalExecInput, TerminalExecResult } from "@bodhiapp/bodhi-pi";
import type { BashOptions, ExecOptions, Bash as JustBash } from "just-bash";
import { createJustBashFsAdapter } from "./just-bash-fs-adapter.js";

const DEFAULT_OUTPUT_BYTE_LIMIT = 256 * 1024;

export type JustBashCtor = new (opts?: BashOptions) => JustBash;

export interface JustBashTerminalOptions {
	filesystem: Filesystem;
	/** Fallback cwd when the caller omits `input.cwd`. Defaults to `/`. */
	defaultCwd?: string;
}

function truncateUtf8(text: string, limit: number): { value: string; truncated: boolean } {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= limit) return { value: text, truncated: false };
	return { value: decoder.decode(bytes.subarray(0, limit)), truncated: true };
}

/**
 * Build a bodhi-pi `Terminal` backed by a just-bash `Bash` shell. Runtime-neutral
 * — caller passes the constructor (`just-bash` for Node, `just-bash/browser` for
 * the browser bundle). Each `exec()` call constructs a fresh `Bash` so shell
 * state (variables, aliases) does not leak between turns; only the underlying
 * filesystem persists across calls.
 */
export function createJustBashTerminal(BashCtor: JustBashCtor, opts: JustBashTerminalOptions): Terminal {
	const fs = createJustBashFsAdapter(opts.filesystem);
	const defaultCwd = opts.defaultCwd ?? "/";

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
			const startedAt = Date.now();
			const limit = input.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT;
			const cwd = input.cwd ?? defaultCwd;
			const bash = new BashCtor({ fs, cwd });

			const controller = new AbortController();
			let timedOut = false;
			let externalAbortListener: (() => void) | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;

			if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					controller.abort(new Error("timeout"));
				}, input.timeoutMs);
			}
			if (input.signal) {
				if (input.signal.aborted) {
					controller.abort(input.signal.reason);
				} else {
					externalAbortListener = () => controller.abort(input.signal?.reason);
					input.signal.addEventListener("abort", externalAbortListener, { once: true });
				}
			}

			const execOptions: ExecOptions = { cwd, signal: controller.signal };
			if (input.env !== undefined) execOptions.env = input.env;
			if (input.stdin !== undefined) execOptions.stdin = input.stdin;

			let stdoutRaw = "";
			let stderrRaw = "";
			let exitCode: number | null = 0;
			let runtimeError: Error | undefined;
			try {
				const result = await bash.exec(input.command, execOptions);
				stdoutRaw = result.stdout ?? "";
				stderrRaw = result.stderr ?? "";
				exitCode = result.exitCode ?? 0;
			} catch (err) {
				runtimeError = err as Error;
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				if (externalAbortListener && input.signal) {
					input.signal.removeEventListener("abort", externalAbortListener);
				}
			}

			const aborted = controller.signal.aborted;
			if (runtimeError && !aborted) {
				stderrRaw = stderrRaw ? `${stderrRaw}\n${runtimeError.message}` : runtimeError.message;
				exitCode = 1;
			}
			if (aborted) {
				exitCode = null;
			}

			const out = truncateUtf8(stdoutRaw, limit);
			const err = truncateUtf8(stderrRaw, limit);

			return {
				stdout: out.value,
				stderr: err.value,
				exitCode,
				signal: aborted ? "SIGTERM" : null,
				durationMs: Date.now() - startedAt,
				timedOut,
				truncated: out.truncated || err.truncated,
			};
		},
	};
}
