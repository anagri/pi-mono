import type { Terminal, TerminalCapabilities, TerminalExecInput, TerminalExecResult } from "@/index.js";

export interface TestTerminalOptions {
	capabilities?: Partial<TerminalCapabilities>;
	handler?: (input: TerminalExecInput) => Promise<TerminalExecResult> | TerminalExecResult;
}

const FULL_CAPABILITIES: TerminalCapabilities = {
	cwd: true,
	env: true,
	stdin: true,
	timeout: true,
	cancel: true,
	separateStreams: true,
};

/**
 * In-memory `Terminal` for tests. Default handler echoes the command on stdout
 * with exit code 0; override `handler` for per-test behaviour.
 */
export function createTestTerminal(opts: TestTerminalOptions = {}): Terminal {
	const capabilities: TerminalCapabilities = { ...FULL_CAPABILITIES, ...opts.capabilities };
	const handler =
		opts.handler ??
		(async (input: TerminalExecInput): Promise<TerminalExecResult> => ({
			stdout: `${input.command}\n`,
			stderr: "",
			exitCode: 0,
			signal: null,
			durationMs: 0,
			timedOut: false,
			truncated: false,
		}));
	return {
		capabilities,
		async exec(input) {
			return handler(input);
		},
	};
}
