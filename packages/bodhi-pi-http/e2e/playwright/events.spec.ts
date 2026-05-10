import { expect, test } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

test.describe("EventsPanel: lifecycle + wire tabs", () => {
	test("captures initialize handshake on connect (wire tab)", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");

		await expect(app.eventsPanel).toBeVisible();
		await app.selectEventTab("wire");

		// Outbound = client → server (request); inbound = server → client (response/notification).
		await expect(app.wireRows({ direction: "out", method: "initialize", kind: "request" })).not.toHaveCount(0);
		await expect(app.wireRows({ direction: "in", kind: "response" })).not.toHaveCount(0);
	});

	test.describe("real-LLM round-trip", () => {
		test.skip(!HAS_KEY, "requires OPENAI_API_KEY");

		test("captures session/prompt + session/update frames around a prompt", async ({ app }) => {
			await app.goto();
			await app.setSettings();
			await app.clickConnect();
			await app.expectStatus("connected");

			await app.send("Reply with the single word: pong");
			await app.expectChatStatus("idle");

			await app.selectEventTab("wire");
			await expect(app.wireRows({ direction: "out", method: "session/prompt" })).not.toHaveCount(0);
			await expect(app.wireRows({ direction: "in", method: "session/update" }).first()).toBeVisible();
		});

		test.describe("lifecycle tab parity with bodhi-pi/e2e/events", () => {
			test.use({ scenario: "workspace-readme" });

			test("text + tool prompt fires the canonical event sequence", async ({ app }) => {
				await app.goto();
				await app.setSettings();
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

				await expect(app.lifecycleRows({ type: "agent_start" }).first()).toHaveAttribute(
					"data-user-prompt",
					/ping/,
				);
				await expect(app.lifecycleRows({ type: "agent_end" }).first()).toHaveAttribute(
					"data-stop-reason",
					"end_turn",
				);

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
			});
		});
	});
});
