import { expect, test } from "./fixtures";

test.describe("M11 EventsPanel: lifecycle + wire tabs (parity with bodhi-pi-web)", () => {
	test("captures the initialize handshake on connect (wire tab)", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "m11-events@example.com", id: 110, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await expect(app.eventsPanel).toBeVisible();
		await app.selectEventTab("wire");

		await expect(app.wireRows({ direction: "in", method: "initialize", kind: "request" })).toHaveCount(1);
		await expect(app.wireRows({ direction: "out", kind: "response" })).not.toHaveCount(0);
	});

	test("captures session/prompt + agent_message_chunk frames around a prompt", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "m11-events@example.com", id: 111, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("Reply with the single word: pong");
		await app.expectChatStatus("idle");

		await app.selectEventTab("wire");
		await expect(app.wireRows({ direction: "in", method: "session/prompt" })).not.toHaveCount(0);
		// agent_message_chunk rides inside the session/update notification's params, not the method.
		await expect(app.wireRows({ direction: "out", method: "session/update" }).first()).toBeVisible();
	});

	test("hides the panel when disconnected", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "m11-events@example.com", id: 112, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await expect(app.eventsPanel).toBeVisible();

		await app.page.getByTestId("disconnect").click();
		await app.expectStatus("disconnected");
		await expect(app.eventsPanel).toHaveCount(0);
	});

	test.describe("lifecycle tab parity with bodhi-pi-web", () => {
		test.use({ scenario: "workspace-readme" });

		test("text + tool prompt fires every event type expected from web's events.spec", async ({ app }) => {
			await app.goto();
			await app.setSettings({ email: "m11-lifecycle@example.com", id: 113, sendToken: true });
			await app.clickConnect();
			await app.expectStatus("connected");

			await expect(app.eventsPanel).toBeVisible();
			await app.selectEventTab("lifecycle");

			await app.send("Reply with the single word: ping");
			await app.expectChatStatus("idle");

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
					app.lifecycleRows({ type: required }),
					`text-prompt event ${required} should fire at least once`,
				).not.toHaveCount(0);
			}

			const start = app.lifecycleRows({ type: "agent_start" }).first();
			await expect(start).toHaveAttribute("data-user-prompt", /ping/);
			const end = app.lifecycleRows({ type: "agent_end" }).first();
			await expect(end).toHaveAttribute("data-stop-reason", "end_turn");

			await app.send("Use the read tool to read readme.txt and reply with its contents verbatim.");
			await app.expectChatStatus("idle");

			for (const required of ["tool_call", "tool_result", "tool_execution_start", "tool_execution_end"]) {
				await expect(
					app.lifecycleRows({ type: required }),
					`tool-round-trip event ${required} should fire at least once`,
				).not.toHaveCount(0);
			}
			await expect(app.lifecycleRows({ type: "tool_execution_start" }).first()).toHaveAttribute(
				"data-tool-name",
				/.+/,
			);
			await expect(app.lifecycleRows({ type: "tool_call" }).first()).toHaveAttribute("data-tool-name", /.+/);
		});
	});
});
