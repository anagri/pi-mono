import { createTestTerminal } from "@test/helpers/terminal.js";
import { describe, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/filesystem/in-memory-filesystem.js";
import type { Terminal, TerminalExecInput } from "@/terminal/terminal.js";
import { createBashTool } from "./bash.js";
import type { ToolDeps } from "./index.js";

function makeDeps(terminal: Terminal): ToolDeps {
	return { filesystem: createInMemoryFilesystem(), cwd: "/proj", terminal };
}

describe("createBashTool", () => {
	test("forwards command to terminal and serialises the result as JSON text", async () => {
		const terminal = createTestTerminal({
			handler: () => ({
				stdout: "hello\n",
				stderr: "",
				exitCode: 0,
				signal: null,
				durationMs: 12,
				timedOut: false,
				truncated: false,
			}),
		});
		const tool = createBashTool(makeDeps(terminal));

		const result = await tool.execute("call-1", { command: "echo hello" });

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		const parsed = JSON.parse(text);
		expect(parsed.stdout).toBe("hello\n");
		expect(parsed.exitCode).toBe(0);
		expect(parsed.durationMs).toBe(12);
		expect(result.details?.exitCode).toBe(0);
	});

	test("resolves relative cwd against session cwd before delegating", async () => {
		let received: TerminalExecInput | undefined;
		const terminal = createTestTerminal({
			handler: (input) => {
				received = input;
				return {
					stdout: "",
					stderr: "",
					exitCode: 0,
					signal: null,
					durationMs: 0,
					timedOut: false,
					truncated: false,
				};
			},
		});
		const tool = createBashTool(makeDeps(terminal));

		await tool.execute("call-1", { command: "pwd", cwd: "sub" });

		expect(received?.cwd).toBe("/proj/sub");
	});

	test("defaults cwd to session cwd when omitted", async () => {
		let received: TerminalExecInput | undefined;
		const terminal = createTestTerminal({
			handler: (input) => {
				received = input;
				return {
					stdout: "",
					stderr: "",
					exitCode: 0,
					signal: null,
					durationMs: 0,
					timedOut: false,
					truncated: false,
				};
			},
		});
		const tool = createBashTool(makeDeps(terminal));

		await tool.execute("call-1", { command: "pwd" });

		expect(received?.cwd).toBe("/proj");
	});

	test("applies default timeout when caller omits timeout_ms", async () => {
		let received: TerminalExecInput | undefined;
		const terminal = createTestTerminal({
			handler: (input) => {
				received = input;
				return {
					stdout: "",
					stderr: "",
					exitCode: 0,
					signal: null,
					durationMs: 0,
					timedOut: false,
					truncated: false,
				};
			},
		});
		const tool = createBashTool(makeDeps(terminal));

		await tool.execute("call-1", { command: "sleep 1" });

		expect(received?.timeoutMs).toBe(120_000);
	});

	test("forwards stdin only when provided", async () => {
		let received: TerminalExecInput | undefined;
		const terminal = createTestTerminal({
			handler: (input) => {
				received = input;
				return {
					stdout: "",
					stderr: "",
					exitCode: 0,
					signal: null,
					durationMs: 0,
					timedOut: false,
					truncated: false,
				};
			},
		});
		const tool = createBashTool(makeDeps(terminal));

		await tool.execute("call-1", { command: "cat", stdin: "hello" });

		expect(received?.stdin).toBe("hello");
	});

	test("non-zero exit code is returned as data, not thrown", async () => {
		const terminal = createTestTerminal({
			handler: () => ({
				stdout: "",
				stderr: "boom",
				exitCode: 2,
				signal: null,
				durationMs: 0,
				timedOut: false,
				truncated: false,
			}),
		});
		const tool = createBashTool(makeDeps(terminal));

		const result = await tool.execute("call-1", { command: "false" });

		expect(result.details?.exitCode).toBe(2);
		expect(result.details?.stderr).toBe("boom");
	});
});
