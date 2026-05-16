import type { Filesystem, ScriptExecutor } from "@bodhiapp/bodhi-pi";
import type { SandboxBridge } from "../sandbox/sandbox-bridge.js";

/**
 * Browser `ScriptExecutor` that delegates code execution to a sandboxed
 * iframe via a `SandboxBridge`. Used by hosts running under a strict CSP
 * (MV3 extensions) where the worker realm cannot use `AsyncFunction`.
 *
 * Reads the script body from the host filesystem (same as the direct-eval
 * variant), then ships it to the sandbox over the bridge for execution.
 */
export function createSandboxedBrowserScriptExecutor(opts: {
	filesystem: Filesystem;
	bridge: SandboxBridge;
}): ScriptExecutor {
	const { filesystem, bridge } = opts;

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

			const slash = scriptPath.lastIndexOf("/");
			const cwd = slash >= 0 ? scriptPath.slice(0, slash) || "/" : "/";

			try {
				return await bridge.runScript({
					code,
					args,
					cwd,
					...(typeof timeout === "number" && timeout > 0 ? { timeout } : {}),
				});
			} catch (err) {
				return {
					stdout: "",
					stderr: `sandbox bridge failure: ${(err as Error).message}`,
					exitCode: 1,
				};
			}
		},
	};
}
