import { expect, test } from "./fixtures";

test.describe("EventsPanel surfaces lifecycle events and ACP wire frames", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: { "/notes.txt": "the secret word is daffodil" },
		},
	});

	test("text + tool + /close fires every event type and surfaces frames on the wire", async ({ chat, events }) => {
		await test.step("boot lands on idle and the panel is mounted", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
			await chat.login("openai", process.env.OPENAI_API_KEY!);
			await expect(events.panel).toBeVisible();
		});

		await test.step("session_start fires before any prompt", async () => {
			await events.selectTab("lifecycle");
			await expect(events.lifecycleRows({ type: "session_start" })).toHaveCount(1);
		});

		await test.step("a text-only prompt surfaces the agent + provider + message events", async () => {
			await chat.send("Reply with the single word: ping");
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 60_000);

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
				await expect(
					events.lifecycleRows({ type: required }),
					`text-prompt event ${required} should fire at least once`,
				).not.toHaveCount(0);
			}

			const start = events.lifecycleRows({ type: "agent_start" }).first();
			await expect(start).toHaveAttribute("data-user-prompt", /ping/);
			const end = events.lifecycleRows({ type: "agent_end" }).first();
			await expect(end).toHaveAttribute("data-stop-reason", "end_turn");
		});

		await test.step("a tool round-trip surfaces tool_call, tool_result, and tool_execution_{start,end}", async () => {
			await chat.send("Use the read tool to read /mnt/demo/notes.txt and tell me the secret word.");
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 60_000);

			for (const required of ["tool_call", "tool_result", "tool_execution_start", "tool_execution_end"]) {
				await expect(
					events.lifecycleRows({ type: required }),
					`tool-round-trip event ${required} should fire at least once`,
				).not.toHaveCount(0);
			}
			await expect(events.lifecycleRows({ type: "tool_execution_start" }).first()).toHaveAttribute(
				"data-tool-name",
				/.+/,
			);
			await expect(events.lifecycleRows({ type: "tool_call" }).first()).toHaveAttribute("data-tool-name", /.+/);
		});

		await test.step("the wire tab carries session/new request + matching response", async () => {
			await events.selectTab("wire");
			// `direction` is from the worker's vantage (the tap runs there):
			// "in" = client→agent, "out" = agent→client.
			await expect(events.wireRows({ method: "session/new", direction: "in", kind: "request" })).not.toHaveCount(0);
			const requestRow = events.wireRows({ method: "session/new", direction: "in", kind: "request" }).first();
			const rpcId = await requestRow.getAttribute("data-rpc-id");
			expect(rpcId).toBeTruthy();
			await expect(events.wireRows({ direction: "out", kind: "response", rpcId: rpcId ?? "" })).not.toHaveCount(0);
			await expect(events.wireRows({ method: "session/prompt", direction: "in" })).not.toHaveCount(0);
		});

		await test.step("/close fires session_shutdown", async () => {
			await events.selectTab("lifecycle");
			await chat.send("/close");
			await chat.waitForState("closed", 30_000);
			await expect(events.lifecycleRows({ type: "session_shutdown" })).not.toHaveCount(0);
		});
	});

	test("/model <other> fires model_select with fromModelId/toModelId populated", async ({ chat, events }) => {
		await test.step("boot defaults to gpt-4o-mini", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
			await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o-mini");
			await chat.login("openai", process.env.OPENAI_API_KEY!);
		});

		await test.step("/model gpt-4o switches the active model", async () => {
			await chat.send("/model gpt-4o");
			await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o");
		});

		await test.step("model_select event records the from→to transition", async () => {
			await events.selectTab("lifecycle");
			const row = events.lifecycleRows({ type: "model_select" }).first();
			await expect(row).toBeVisible();
			await expect(row).toHaveAttribute("data-from-model-id", "gpt-4o-mini");
			await expect(row).toHaveAttribute("data-to-model-id", "gpt-4o");
		});
	});
});
