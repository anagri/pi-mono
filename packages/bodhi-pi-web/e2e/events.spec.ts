import { expect, test } from "./fixtures";

test("worker posts the full event sequence to window.__bodhiPiEventLog (gpt-4o-mini)", async ({ chat, page }) => {
	await test.step("boot lands on idle state", async () => {
		await chat.goto();
		await chat.waitForState("idle", 60_000);
	});

	await test.step("event log is initialized by the runtime", async () => {
		const logExists = await page.evaluate(() =>
			Array.isArray((window as { __bodhiPiEventLog?: unknown }).__bodhiPiEventLog),
		);
		expect(logExists).toBe(true);
	});

	await test.step("session_start fires before any prompt", async () => {
		const types = await page.evaluate(() =>
			((window as { __bodhiPiEventLog?: { type: string }[] }).__bodhiPiEventLog ?? []).map((r) => r.type),
		);
		expect(types).toContain("session_start");
	});

	await test.step("send a prompt", async () => {
		await chat.send("Reply with the single word: ping");
		await chat.waitForState("streaming");
		await chat.waitForState("idle", 60_000);
	});

	await test.step("event log contains the full agent run sequence", async () => {
		const types = await page.evaluate(() =>
			((window as { __bodhiPiEventLog?: { type: string }[] }).__bodhiPiEventLog ?? []).map((r) => r.type),
		);
		expect(types).toContain("input");
		expect(types).toContain("before_agent_start");
		expect(types).toContain("agent_start");
		expect(types).toContain("turn_start");
		expect(types).toContain("turn_end");
		expect(types).toContain("agent_end");
		expect(types).toContain("before_provider_request");
		expect(types).toContain("after_provider_response");
	});

	await test.step("agent_start carries the user prompt; agent_end carries stopReason", async () => {
		const records = await page.evaluate(
			() =>
				(window as { __bodhiPiEventLog?: { type: string; userPrompt?: string; stopReason?: string }[] })
					.__bodhiPiEventLog ?? [],
		);
		const start = records.find((r) => r.type === "agent_start");
		const end = records.find((r) => r.type === "agent_end");
		expect(start?.userPrompt).toContain("ping");
		expect(end?.stopReason).toBe("end_turn");
	});
});
