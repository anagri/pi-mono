/**
 * Host-injected shell. Powers the optional `bash` built-in tool.
 *
 * Implementations are runtime-specific:
 *   - Node hosts may use `child_process.spawn('bash', ['-c', command], ...)`.
 *   - Browser hosts may wrap `just-bash/browser` over an `IFileSystem` adapter.
 *   - Embedded hosts may use any sandboxed shell they prefer.
 *
 * Adapters declare which input fields they honour via `capabilities`. Fields the
 * adapter cannot enforce (e.g. `env` on a browser shell) are silently ignored
 * rather than rejected — the tool layer queries `capabilities` to describe the
 * effective shell to the model.
 */
export interface Terminal {
	readonly capabilities: TerminalCapabilities;
	exec(input: TerminalExecInput): Promise<TerminalExecResult>;
}

export interface TerminalCapabilities {
	cwd: boolean;
	env: boolean;
	stdin: boolean;
	timeout: boolean;
	cancel: boolean;
	/** false => stderr is always empty; merged output lands in stdout (e.g. PTY-backed shells). */
	separateStreams: boolean;
}

export interface TerminalExecInput {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	stdin?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	outputByteLimit?: number;
}

export interface TerminalExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
	timedOut: boolean;
	truncated: boolean;
}
