import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import { wireInternalEventHandlers } from "@/acp/event-wiring.js";
import { EventDispatcher } from "@/events/dispatcher.js";
import { createEvent } from "@/events/factory.js";
import type { ModelRegistry } from "@/models/registry.js";
import type { SessionState } from "@/sessions/session-state.js";
import { LIFECYCLE_EVENT_METHOD } from "@/wire/constants.js";

function setup() {
	const ext: Array<{ method: string; params: Record<string, unknown> }> = [];
	const conn = {
		sessionUpdate: async () => {},
		extNotification: async (method: string, params: Record<string, unknown>) => {
			ext.push({ method, params });
		},
	} as unknown as AgentSideConnection;
	const logger = { error: () => {}, warn: () => {} };
	const events = new EventDispatcher(undefined, logger);
	const sessions = new Map<string, SessionState>();
	const modelRegistry = { buildAllConfigOptions: async () => [] } as unknown as ModelRegistry;
	wireInternalEventHandlers({ events, conn, sessions, modelRegistry, logger });
	const lifecycleTypes = () =>
		ext.filter((e) => e.method === LIFECYCLE_EVENT_METHOD).map((e) => (e.params as { type: string }).type);
	return { events, ext, lifecycleTypes };
}

describe("event-wiring LIFECYCLE_EVENT_METHOD forwarding", () => {
	test("forwards compaction + branch-summary + navigate to the wire", async () => {
		const { events, lifecycleTypes } = setup();
		await events.emit(createEvent("compaction_start", { sessionId: "s1", reason: "manual" }));
		await events.emit(
			createEvent("compaction_end", {
				sessionId: "s1",
				reason: "manual",
				summary: "x",
				firstKeptEntryId: "e1",
				tokensBefore: 100,
			}),
		);
		await events.emit(
			createEvent("branch_summary_created", {
				sessionId: "s1",
				abandonedTailLeafId: "l1",
				commonAncestorId: null,
				summary: "s",
			}),
		);
		await events.emit(
			createEvent("session_navigate", { sessionId: "s1", fromLeafId: null, toLeafId: "l2", crossedBranches: true }),
		);
		expect(lifecycleTypes()).toEqual([
			"compaction_start",
			"compaction_end",
			"branch_summary_created",
			"session_navigate",
		]);
	});

	test("forwards mcp + subagent lifecycle, including the empty-sessionId oauth edge", async () => {
		const { events, lifecycleTypes } = setup();
		await events.emit(createEvent("mcp_status_change", { sessionId: "s1", slug: "x", status: "connected" }));
		await events.emit(createEvent("mcp_tools_change", { sessionId: "s1", slug: "x", toolNames: ["a"] }));
		await events.emit(createEvent("mcp_oauth_status_change", { sessionId: "", slug: "x", status: "completed" }));
		expect(lifecycleTypes()).toEqual(["mcp_status_change", "mcp_tools_change", "mcp_oauth_status_change"]);
	});
});
