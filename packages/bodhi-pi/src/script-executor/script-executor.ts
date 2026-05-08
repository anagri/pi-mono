/**
 * Host-injected JavaScript runner. Powers the optional `run_script` built-in tool.
 *
 * Implementations are runtime-specific:
 *   - Node hosts may use `vm.runInNewContext` or spawn a subprocess.
 *   - Browser hosts may use a Web Worker with a blob URL.
 *   - Embedded hosts may use quickjs-emscripten or any sandbox they prefer.
 *
 * Implementations SHOULD NOT expose host capabilities (filesystem, network,
 * agent internals) to the script. Scripts come from project disk and are
 * trusted at the same level as `Filesystem` reads, but isolating execution
 * keeps sloppy or compromised scripts from doing damage.
 */
export interface ScriptExecutor {
	execute(params: ScriptExecuteParams): Promise<ScriptExecuteResult>;
}

export interface ScriptExecuteParams {
	scriptPath: string;
	cwd: string;
	args: string[];
	timeout?: number;
}

export interface ScriptExecuteResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}
