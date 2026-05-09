import { expectTextContent } from "@test/helpers/expect-text-content.js";
import { describe, expect, test } from "vitest";
import type { ScriptExecuteParams, ScriptExecutor } from "@/script-executor/script-executor.js";
import { createRunScriptTool } from "./run-script.js";

function makeExecutor(impl: ScriptExecutor["execute"]): ScriptExecutor {
	return { execute: impl };
}

describe("createRunScriptTool", () => {
	test("resolves relative path against cwd before delegating", async () => {
		let received: ScriptExecuteParams | undefined;
		const executor = makeExecutor(async (params) => {
			received = params;
			return { stdout: "out", stderr: "", exitCode: 0 };
		});
		const tool = createRunScriptTool({ executor, cwd: "/proj" });

		await tool.execute("call-1", { path: "scripts/run.js", args: ["a", "b"] });

		expect(received?.scriptPath).toBe("/proj/scripts/run.js");
		expect(received?.cwd).toBe("/proj");
		expect(received?.args).toEqual(["a", "b"]);
	});

	test("absolute path is passed through unchanged", async () => {
		let received: ScriptExecuteParams | undefined;
		const executor = makeExecutor(async (params) => {
			received = params;
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		const tool = createRunScriptTool({ executor, cwd: "/proj" });

		await tool.execute("call-1", { path: "/elsewhere/script.js" });

		expect(received?.scriptPath).toBe("/elsewhere/script.js");
		expect(received?.args).toEqual([]);
	});

	test("formats stdout, stderr, and exitCode in the tool result", async () => {
		const executor = makeExecutor(async () => ({ stdout: "hello", stderr: "warn", exitCode: 0 }));
		const tool = createRunScriptTool({ executor, cwd: "/proj" });

		const result = await tool.execute("call-1", { path: "x.js" });

		const text = expectTextContent(result);
		expect(text).toContain("stdout:\nhello");
		expect(text).toContain("stderr:\nwarn");
		expect(text).toContain("exitCode: 0");
	});

	test("non-zero exit code surfaces in the tool result", async () => {
		const executor = makeExecutor(async () => ({ stdout: "", stderr: "boom", exitCode: 1 }));
		const tool = createRunScriptTool({ executor, cwd: "/proj" });

		const result = await tool.execute("call-1", { path: "x.js" });
		const text = expectTextContent(result);
		expect(text).toContain("exitCode: 1");
	});

	test("empty stdout and stderr produces only the exitCode line", async () => {
		const executor = makeExecutor(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
		const tool = createRunScriptTool({ executor, cwd: "/proj" });

		const result = await tool.execute("call-1", { path: "x.js" });
		const text = expectTextContent(result);
		expect(text).toBe("exitCode: 1");
	});

	test("stdout larger than RUN_SCRIPT_MAX_BYTES is truncated", async () => {
		const big = "x".repeat(60_000);
		const executor = makeExecutor(async () => ({ stdout: big, stderr: "", exitCode: 0 }));
		const tool = createRunScriptTool({ executor, cwd: "/proj" });

		const result = await tool.execute("call-1", { path: "x.js" });
		const text = expectTextContent(result);
		expect(text).toContain("(truncated to");
		expect(text.length).toBeLessThan(big.length);
	});

	test("forwards timeout when supplied", async () => {
		let received: ScriptExecuteParams | undefined;
		const executor = makeExecutor(async (params) => {
			received = params;
			return { stdout: "", stderr: "", exitCode: 0 };
		});
		const tool = createRunScriptTool({ executor, cwd: "/proj" });

		await tool.execute("call-1", { path: "x.js", timeout: 5000 });
		expect(received?.timeout).toBe(5000);
	});
});
