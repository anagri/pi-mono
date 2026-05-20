import type { AgentSideConnection, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { EventDispatcher } from "@/events/dispatcher.js";
import type { McpToolAnnotations } from "@/mcp/mcp-types.js";
import type { SessionState } from "@/sessions/session-state.js";
import { PermissionService } from "./permission-service.js";
import { MODE_PRESETS } from "./presets.js";
import type { AgentMode } from "./types.js";

function makeSessionWithMode(mode: AgentMode, approvalTimeoutMs: number): SessionState {
	return {
		runtime: { mode, permissionGrants: new Map(), pendingApprovals: new Map(), approvalTimeoutMs },
	} as unknown as SessionState;
}

interface BuildOpts {
	mcpAnnotationLookup?: (sessionId: string, fullName: string) => McpToolAnnotations | undefined;
	/** Verdict the stub `conn.requestPermission` returns; defaults to `allow_once`. */
	requestPermission?: () => Promise<RequestPermissionResponse>;
	approvalTimeoutMs?: number;
}

function buildService(
	mode: AgentMode,
	opts: BuildOpts = {},
): { service: PermissionService; sessionId: string; session: SessionState } {
	const sessions = new Map<string, SessionState>();
	const sessionId = "s1";
	const session = makeSessionWithMode(mode, opts.approvalTimeoutMs ?? 30000);
	sessions.set(sessionId, session);
	const conn = {
		sessionUpdate: async () => {},
		requestPermission:
			opts.requestPermission ??
			(async (): Promise<RequestPermissionResponse> => ({
				outcome: { outcome: "selected", optionId: "allow_once" },
			})),
	} as unknown as AgentSideConnection;
	const service = new PermissionService({
		sessions,
		events: new EventDispatcher(),
		conn,
		appendEntry: async () => {},
		capabilities: { allowsAllowAllMode: true, allowsAllowAllModeAsDefault: false },
		logger: console,
		...(opts.mcpAnnotationLookup ? { mcpAnnotationLookup: opts.mcpAnnotationLookup } : {}),
	});
	return { service, sessionId, session };
}

describe("PermissionService.evaluateToolCall — plan mode", () => {
	it("allows read tool", async () => {
		const { service, sessionId } = buildService("plan");
		const decision = await service.evaluateToolCall(sessionId, { id: "tc1", name: "read", arguments: {} });
		expect(decision).toEqual({ kind: "allow" });
	});

	it("allows search tools (ls, find, grep)", async () => {
		const { service, sessionId } = buildService("plan");
		for (const name of ["ls", "find", "grep"]) {
			const d = await service.evaluateToolCall(sessionId, { id: "tc1", name, arguments: {} });
			expect(d, `${name} should be allowed`).toEqual({ kind: "allow" });
		}
	});

	it("allows subagent", async () => {
		const { service, sessionId } = buildService("plan");
		const decision = await service.evaluateToolCall(sessionId, { id: "tc1", name: "subagent", arguments: {} });
		expect(decision).toEqual({ kind: "allow" });
	});

	it("denies edit-category tools (write, edit)", async () => {
		const { service, sessionId } = buildService("plan");
		for (const name of ["write", "edit"]) {
			const d = await service.evaluateToolCall(sessionId, { id: "tc1", name, arguments: {} });
			expect(d.kind, `${name} should be denied`).toBe("deny");
		}
	});

	it("denies execute-category tools (bash, run_script)", async () => {
		const { service, sessionId } = buildService("plan");
		for (const name of ["bash", "run_script"]) {
			const d = await service.evaluateToolCall(sessionId, { id: "tc1", name, arguments: {} });
			expect(d.kind, `${name} should be denied`).toBe("deny");
		}
	});

	it("denies unknown 'other' tools defensively", async () => {
		const { service, sessionId } = buildService("plan");
		const d = await service.evaluateToolCall(sessionId, { id: "tc1", name: "totally_unknown_tool", arguments: {} });
		expect(d.kind).toBe("deny");
	});

	it("deny reason follows the redirect template with toolName + category + /mode edit hint", async () => {
		const { service, sessionId } = buildService("plan");
		const d = await service.evaluateToolCall(sessionId, { id: "tc1", name: "write", arguments: {} });
		expect(d.kind).toBe("deny");
		if (d.kind !== "deny") return;
		expect(d.reason).toContain("plan mode");
		expect(d.reason).toContain("write");
		expect(d.reason).toContain("edit"); // category and/or /mode edit hint
		expect(d.reason).toContain("/mode edit");
	});

	it("allows MCP tool with readOnlyHint=true", async () => {
		const { service, sessionId } = buildService("plan", {
			mcpAnnotationLookup: () => ({ readOnlyHint: true }),
		});
		const d = await service.evaluateToolCall(sessionId, { id: "tc1", name: "github__list_issues", arguments: {} });
		expect(d).toEqual({ kind: "allow" });
	});

	it("denies MCP tool with destructiveHint=true", async () => {
		const { service, sessionId } = buildService("plan", {
			mcpAnnotationLookup: () => ({ destructiveHint: true }),
		});
		const d = await service.evaluateToolCall(sessionId, { id: "tc1", name: "github__delete_repo", arguments: {} });
		expect(d.kind).toBe("deny");
	});

	it("allows MCP tool with no annotations (research-permissive default)", async () => {
		const { service, sessionId } = buildService("plan", {
			mcpAnnotationLookup: () => undefined,
		});
		const d = await service.evaluateToolCall(sessionId, { id: "tc1", name: "github__unknown_tool", arguments: {} });
		expect(d).toEqual({ kind: "allow" });
	});

	it("allows MCP tool when no lookup is provided (default-permissive)", async () => {
		const { service, sessionId } = buildService("plan");
		const d = await service.evaluateToolCall(sessionId, { id: "tc1", name: "github__unknown_tool", arguments: {} });
		expect(d).toEqual({ kind: "allow" });
	});
});

describe("PermissionService.evaluateToolCall — ask mode (040)", () => {
	it("auto-allows read/search/subagent without prompting", async () => {
		const { service, sessionId } = buildService("ask", {
			requestPermission: async () => {
				throw new Error("should not prompt for auto-allow categories");
			},
		});
		for (const name of ["read", "ls", "find", "grep", "subagent"]) {
			const d = await service.evaluateToolCall(sessionId, { id: "tc1", name, arguments: {} });
			expect(d, `${name} in ask mode`).toEqual({ kind: "allow" });
		}
	});

	it("prompts for edit/execute/other and resolves the verdict (allow_once → allow)", async () => {
		const { service, sessionId } = buildService("ask");
		for (const name of ["write", "edit", "bash", "totally_unknown_tool"]) {
			const d = await service.evaluateToolCall(sessionId, { id: "tc1", name, arguments: {} });
			expect(d, `${name} in ask mode`).toEqual({ kind: "allow" });
		}
	});

	it("blocks when the user rejects (reject_once → deny)", async () => {
		const { service, sessionId } = buildService("ask", {
			requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "reject_once" } }),
		});
		const d = await service.evaluateToolCall(sessionId, { id: "tc1", name: "write", arguments: {} });
		expect(d.kind).toBe("deny");
	});

	it("blocks when the prompt is cancelled", async () => {
		const { service, sessionId } = buildService("ask", {
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		});
		const d = await service.evaluateToolCall(sessionId, { id: "tc1", name: "bash", arguments: {} });
		expect(d.kind).toBe("deny");
	});

	it("blocks when the prompt times out", async () => {
		const { service, sessionId } = buildService("ask", {
			approvalTimeoutMs: 10,
			requestPermission: () => new Promise(() => {}),
		});
		const d = await service.evaluateToolCall(sessionId, { id: "tc1", name: "write", arguments: {} });
		expect(d.kind).toBe("deny");
	});
});

describe("PermissionService.evaluateToolCall — ask-mode session grants", () => {
	it("allow_always records a grant so the same tool skips the second prompt", async () => {
		let calls = 0;
		const { service, sessionId, session } = buildService("ask", {
			requestPermission: async () => {
				calls++;
				return { outcome: { outcome: "selected", optionId: "allow_always" } };
			},
		});
		const first = await service.evaluateToolCall(sessionId, { id: "tc1", name: "write", arguments: {} });
		const second = await service.evaluateToolCall(sessionId, { id: "tc2", name: "write", arguments: {} });
		expect(first).toEqual({ kind: "allow" });
		expect(second).toEqual({ kind: "allow" });
		expect(calls, "only the first call prompts").toBe(1);
		expect(session.runtime.permissionGrants.get("write")).toBe("allow");
	});

	it("reject_always records a deny grant so the same tool is blocked without re-prompting", async () => {
		let calls = 0;
		const { service, sessionId, session } = buildService("ask", {
			requestPermission: async () => {
				calls++;
				return { outcome: { outcome: "selected", optionId: "reject_always" } };
			},
		});
		const first = await service.evaluateToolCall(sessionId, { id: "tc1", name: "bash", arguments: {} });
		const second = await service.evaluateToolCall(sessionId, { id: "tc2", name: "bash", arguments: {} });
		expect(first.kind).toBe("deny");
		expect(second.kind).toBe("deny");
		expect(calls, "only the first call prompts").toBe(1);
		expect(session.runtime.permissionGrants.get("bash")).toBe("deny");
	});

	it("setMode clears session grants so a later mode does not inherit an allow_always", async () => {
		const { service, sessionId, session } = buildService("ask", {
			requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow_always" } }),
		});
		await service.evaluateToolCall(sessionId, { id: "tc1", name: "write", arguments: {} });
		expect(session.runtime.permissionGrants.size).toBe(1);
		await service.setMode(sessionId, "plan", "user");
		expect(session.runtime.permissionGrants.size).toBe(0);
	});
});

describe("PermissionService.evaluateToolCall — edit/allow-all stay permissive", () => {
	it("edit mode allows every tool (enforcement is milestone 050)", async () => {
		const { service, sessionId } = buildService("edit");
		for (const name of ["read", "write", "edit", "bash", "subagent", "totally_unknown_tool"]) {
			const d = await service.evaluateToolCall(sessionId, { id: "tc1", name, arguments: {} });
			expect(d, `${name} in edit mode`).toEqual({ kind: "allow" });
		}
	});

	it("allow-all mode allows every tool", async () => {
		const { service, sessionId } = buildService("allow-all");
		for (const name of ["read", "write", "edit", "bash", "subagent", "totally_unknown_tool"]) {
			const d = await service.evaluateToolCall(sessionId, { id: "tc1", name, arguments: {} });
			expect(d, `${name} in allow-all mode`).toEqual({ kind: "allow" });
		}
	});
});

describe("MODE_PRESETS.plan", () => {
	it("has populated policy categories per the locked table", () => {
		expect(MODE_PRESETS.plan.policy.categories).toEqual({
			read: "allow",
			search: "allow",
			subagent: "allow",
			edit: "deny",
			execute: "deny",
			other: "deny",
		});
	});

	it("carries the planner system-prompt suffix", () => {
		const suffix = MODE_PRESETS.plan.systemPromptSuffix;
		expect(suffix).toBeDefined();
		expect(suffix).toContain("PLAN MODE");
		expect(suffix).toContain("read-only");
	});

	it("fills ask (040) and leaves edit empty until 050; allow-all stays permissive", () => {
		expect(MODE_PRESETS.ask.policy.categories).toEqual({
			read: "allow",
			search: "allow",
			subagent: "allow",
			edit: "ask",
			execute: "ask",
			mcp: "ask",
			other: "ask",
		});
		expect(MODE_PRESETS.edit.policy.categories).toEqual({});
		// allow-all keeps its phase-0 fully-permissive policy
		expect(MODE_PRESETS["allow-all"].policy.categories.read).toBe("allow");
	});
});
