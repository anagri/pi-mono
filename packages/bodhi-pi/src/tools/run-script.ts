import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ScriptExecutor } from "@/script-executor/script-executor.js";
import { resolvePath } from "./index.js";
import { RUN_SCRIPT_MAX_BYTES } from "./limits.js";

const runScriptSchema = Type.Object({
	path: Type.String({ description: "Path to the JavaScript file to execute (relative or absolute)" }),
	args: Type.Optional(Type.Array(Type.String(), { description: "Positional arguments passed to the script" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (host-enforced if supported)" })),
});

type RunScriptInput = Static<typeof runScriptSchema>;

interface CreateRunScriptToolOptions {
	executor: ScriptExecutor;
	cwd: string;
}

function truncate(label: string, text: string): string {
	if (Buffer.byteLength(text, "utf-8") <= RUN_SCRIPT_MAX_BYTES) return `${label}:\n${text}`;
	const trimmed = Buffer.from(text, "utf-8").subarray(0, RUN_SCRIPT_MAX_BYTES).toString("utf-8");
	return `${label} (truncated to ${Math.floor(RUN_SCRIPT_MAX_BYTES / 1024)}KB):\n${trimmed}`;
}

export function createRunScriptTool({ executor, cwd }: CreateRunScriptToolOptions): AgentTool<typeof runScriptSchema> {
	return {
		name: "run_script",
		label: "run_script",
		description: `Execute a JavaScript file at PATH with positional ARGS. Returns stdout/stderr and exit code. Output truncated to ${Math.floor(RUN_SCRIPT_MAX_BYTES / 1024)}KB per stream.`,
		parameters: runScriptSchema,
		async execute(_toolCallId: string, { path: scriptPath, args, timeout }: RunScriptInput) {
			const absolutePath = resolvePath(cwd, scriptPath);
			const result = await executor.execute({
				scriptPath: absolutePath,
				cwd,
				args: args ?? [],
				...(timeout !== undefined ? { timeout } : {}),
			});
			const parts: string[] = [];
			if (result.stdout) parts.push(truncate("stdout", result.stdout));
			if (result.stderr) parts.push(truncate("stderr", result.stderr));
			parts.push(`exitCode: ${result.exitCode}`);
			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: undefined,
			};
		},
	};
}
