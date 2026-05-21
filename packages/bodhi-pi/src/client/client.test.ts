import { describe, expect, test } from "vitest";
import { createBodhiPiClient } from "./client.js";
import type { BodhiPiAcpConnection } from "./types.js";

function fakeConn(extResult: Record<string, unknown> = {}) {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const conn = {
		extMethod: async (method: string, params: Record<string, unknown>) => {
			calls.push({ method, params });
			return extResult;
		},
	} as unknown as BodhiPiAcpConnection;
	return { conn, calls };
}

describe("BodhiPiClient subagent methods", () => {
	test("runSubagent hits _bodhi-pi/subagent/run with sessionId/agent/task/model", async () => {
		const { conn, calls } = fakeConn({ childSessionId: "c1", status: "completed", durationMs: 1, toolCount: 0 });
		const client = createBodhiPiClient(conn);
		const res = await client.runSubagent({ sessionId: "s1", agent: "explore", task: "do it", model: "m1" });
		expect(calls).toEqual([
			{
				method: "_bodhi-pi/subagent/run",
				params: { sessionId: "s1", agent: "explore", task: "do it", model: "m1" },
			},
		]);
		expect(res.childSessionId).toBe("c1");
	});

	test("runSubagent omits model when not supplied", async () => {
		const { conn, calls } = fakeConn();
		const client = createBodhiPiClient(conn);
		await client.runSubagent({ sessionId: "s1", agent: "explore", task: "do it" });
		expect(calls[0].params).toEqual({ sessionId: "s1", agent: "explore", task: "do it" });
	});

	test("listSubagents hits _bodhi-pi/subagent/list with sessionId", async () => {
		const { conn, calls } = fakeConn({ profiles: [] });
		const client = createBodhiPiClient(conn);
		await client.listSubagents({ sessionId: "s1" });
		expect(calls).toEqual([{ method: "_bodhi-pi/subagent/list", params: { sessionId: "s1" } }]);
	});

	test("subagentChildren hits _bodhi-pi/subagent/children with sessionId", async () => {
		const { conn, calls } = fakeConn({ children: [] });
		const client = createBodhiPiClient(conn);
		await client.subagentChildren({ sessionId: "s1" });
		expect(calls).toEqual([{ method: "_bodhi-pi/subagent/children", params: { sessionId: "s1" } }]);
	});
});
