import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { Terminal, TerminalExecInput } from "@/terminal/terminal.js";
import { resolvePath, type ToolDeps } from "./index.js";

const BASH_OUTPUT_BYTE_LIMIT = 256 * 1024; // 256 KiB per stream (matches web-acp-agent)
const BASH_DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes (matches opencode)

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute. Supports pipes and redirections." }),
	description: Type.Optional(
		Type.String({ description: "Clear, concise 5-10 word summary of what the command does." }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the command. Defaults to the session cwd." })),
	timeout_ms: Type.Optional(
		Type.Number({
			description: `Hard timeout in milliseconds. Defaults to ${BASH_DEFAULT_TIMEOUT_MS}.`,
			minimum: 1,
		}),
	),
	stdin: Type.Optional(Type.String({ description: "Standard input piped into the command." })),
});

type BashInput = Static<typeof bashSchema>;

export function createBashTool(deps: ToolDeps): AgentTool<typeof bashSchema> {
	const terminal = deps.terminal;
	if (!terminal) {
		throw new Error("bash: createBashTool called without deps.terminal (registration bug)");
	}
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command. Returns stdout, stderr, exit code, and a truncated flag (per-stream cap ${Math.floor(
			BASH_OUTPUT_BYTE_LIMIT / 1024,
		)} KiB). Non-zero exit codes are returned as data, not thrown.`,
		parameters: bashSchema,
		async execute(_toolCallId: string, input: BashInput) {
			return execBash(terminal, deps.cwd, input);
		},
	};
}

async function execBash(terminal: Terminal, sessionCwd: string, input: BashInput) {
	const cwd = input.cwd ? resolvePath(sessionCwd, input.cwd) : sessionCwd;
	const timeoutMs = input.timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS;
	const execInput: TerminalExecInput = {
		command: input.command,
		cwd,
		timeoutMs,
		outputByteLimit: BASH_OUTPUT_BYTE_LIMIT,
	};
	if (input.stdin !== undefined) execInput.stdin = input.stdin;
	const result = await terminal.exec(execInput);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(result) }],
		details: result,
	};
}
