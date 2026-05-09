import { expect, test } from "./fixtures";

const RECORD_TYPE = "type";

interface EventRecord {
	type: string;
	sessionId?: string;
	toolName?: string;
	userPrompt?: string;
	stopReason?: string;
	fromModelId?: string;
	toModelId?: string;
}

async function readLog(page: import("@playwright/test").Page): Promise<EventRecord[]> {
	return page.evaluate(() => (window as { __bodhiPiEventLog?: EventRecord[] }).__bodhiPiEventLog ?? []);
}

test.describe("M5.2 worker bridges the 19-event lifecycle to window.__bodhiPiEventLog", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: { "/notes.txt": "the secret word is daffodil" },
		},
	});

	test("text + tool + /close fires every event type except model_select and tool_execution_update", async ({
		chat,
		page,
	}) => {
		await test.step("boot lands on idle and the log array is initialised", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
			const logExists = await page.evaluate(() =>
				Array.isArray((window as { __bodhiPiEventLog?: unknown }).__bodhiPiEventLog),
			);
			expect(logExists, "runtime initialises window.__bodhiPiEventLog when recordEvents=true").toBe(true);
		});

		await test.step("session_start fires before any prompt", async () => {
			const types = (await readLog(page)).map((r) => r[RECORD_TYPE]);
			expect(types).toContain("session_start");
		});

		await test.step("a text-only prompt surfaces the agent + provider + message events", async () => {
			await chat.send("Reply with the single word: ping");
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 60_000);

			const log = await readLog(page);
			const types = log.map((r) => r[RECORD_TYPE]);
			for (const required of [
				"input",
				"before_agent_start",
				"agent_start",
				"turn_start",
				"message_start",
				"message_update",
				"message_end",
				"turn_end",
				"agent_end",
				"before_provider_request",
				"after_provider_response",
			]) {
				expect(types, `text-prompt event ${required} should fire at least once`).toContain(required);
			}

			const start = log.find((r) => r.type === "agent_start");
			const end = log.find((r) => r.type === "agent_end");
			expect(start?.userPrompt).toContain("ping");
			expect(end?.stopReason).toBe("end_turn");
		});

		await test.step("a tool round-trip surfaces tool_call, tool_result, and tool_execution_{start,end}", async () => {
			await chat.send("Use the read tool to read /mnt/demo/notes.txt and tell me the secret word.");
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 60_000);

			const log = await readLog(page);
			const types = log.map((r) => r[RECORD_TYPE]);
			for (const required of ["tool_call", "tool_result", "tool_execution_start", "tool_execution_end"]) {
				expect(types, `tool-round-trip event ${required} should fire at least once`).toContain(required);
			}

			// Each of those four events carries `toolName` per worker.ts:24-32.
			const toolStart = log.find((r) => r.type === "tool_execution_start");
			expect(toolStart?.toolName, "tool_execution_start carries toolName").toBeDefined();
			const toolCall = log.find((r) => r.type === "tool_call");
			expect(toolCall?.toolName, "tool_call carries toolName").toBeDefined();
		});

		await test.step("/close fires session_shutdown", async () => {
			await chat.send("/close");
			await chat.waitForState("closed", 30_000);

			const types = (await readLog(page)).map((r) => r[RECORD_TYPE]);
			expect(types).toContain("session_shutdown");
		});
	});

	test("/model <other> fires model_select with fromModelId/toModelId populated", async ({ chat, page }) => {
		await test.step("boot defaults to gpt-4o-mini", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
			await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o-mini");
		});

		await test.step("/model gpt-4o switches the active model", async () => {
			await chat.send("/model gpt-4o");
			await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o");
		});

		await test.step("model_select event records the from→to transition", async () => {
			const log = await readLog(page);
			const select = log.find((r) => r.type === "model_select");
			expect(select, "model_select should fire on /model switch").toBeDefined();
			expect(select?.fromModelId).toBe("gpt-4o-mini");
			expect(select?.toModelId).toBe("gpt-4o");
		});
	});
});
