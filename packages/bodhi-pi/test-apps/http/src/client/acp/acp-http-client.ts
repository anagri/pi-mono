/**
 * Browser-side ACP-over-HTTP client. Mirrors the methods of `ClientSideConnection`
 * from `@agentclientprotocol/sdk` so existing hooks port verbatim, but each
 * method is its own HTTP request:
 *
 *  - JSON methods (initialize, newSession, listSessions, extMethod, cancel) →
 *    `POST /acp` with `Accept: application/json`.
 *  - SSE methods (prompt, loadSession) → `POST /acp` with `Accept: text/event-stream`,
 *    parsed via `parseSse`. Each notification fires registered `sessionUpdate`
 *    handlers; the final JSON-RPC response resolves the call.
 *
 * Observability hooks (M14, M15):
 *  - `onLifecycleEvent` — receives `_bodhi-pi/lifecycle/event` extNotifications
 *    that arrive on the SSE stream during prompt/load.
 *  - `frameTap` — every outbound JSON-RPC body and every inbound JSON-RPC frame
 *    (one per SSE event, or the final JSON response for non-SSE methods) is
 *    pushed to a configured EventLog when set.
 */
import type { EventLog } from "../lib/event-log.ts";
import { parseSse } from "./sse-parser.ts";

export type SessionNotificationHandler = (notification: {
	sessionId: string;
	update: { sessionUpdate: string; [k: string]: unknown };
}) => void;

export type LifecycleEventHandler = (params: Record<string, unknown>) => void;

export interface AcpClientConfig {
	/** Token already encoded as base64url JSON. */
	token: string;
	/** Base URL of the server, e.g. `""` (same origin) or `http://localhost:3000`. */
	baseUrl?: string;
	/** When set, every outbound + inbound JSON-RPC frame is pushed here. */
	eventLog?: EventLog;
}

export class RpcError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.data = data;
	}
}

interface JsonRpcSuccess<T> {
	jsonrpc: "2.0";
	id: number | string | null;
	result: T;
}

interface JsonRpcError {
	jsonrpc: "2.0";
	id: number | string | null;
	error: { code: number; message: string; data?: unknown };
}

import { LIFECYCLE_EVENT_METHOD } from "@bodhiapp/bodhi-pi";

let nextId = 1;

export class AcpHttpClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly eventLog: EventLog | undefined;

	constructor(cfg: AcpClientConfig) {
		this.baseUrl = cfg.baseUrl ?? "";
		this.token = cfg.token;
		this.eventLog = cfg.eventLog;
	}

	private tap(direction: "in" | "out", raw: string): void {
		if (!this.eventLog) return;
		this.eventLog.publish({ direction, raw, ts: Date.now() });
	}

	private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
		const id = nextId++;
		const reqBody = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		this.tap("out", reqBody);
		const res = await fetch(`${this.baseUrl}/acp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				authorization: `Bearer ${this.token}`,
			},
			body: reqBody,
		});
		if (!res.ok) {
			throw new RpcError(res.status, `HTTP ${res.status} ${res.statusText}`);
		}
		const text = await res.text();
		this.tap("in", text);
		const body = JSON.parse(text) as JsonRpcSuccess<T> | JsonRpcError;
		if ("error" in body) {
			throw new RpcError(body.error.code, body.error.message, body.error.data);
		}
		return body.result;
	}

	initialize(params: Record<string, unknown> = {}): Promise<{
		protocolVersion: number;
		agentInfo?: { name: string; version: string };
		agentCapabilities?: unknown;
	}> {
		return this.call("initialize", { protocolVersion: 1, clientCapabilities: {}, ...params });
	}

	newSession(params: { cwd?: string; mcpServers?: unknown[] } = {}): Promise<{
		sessionId: string;
		configOptions?: { id: string; currentValue: string; options?: { value: string; name?: string }[] }[];
		availableCommands?: { name: string; description: string; input?: { hint?: string } }[];
	}> {
		return this.call("session/new", { cwd: params.cwd ?? "/", mcpServers: params.mcpServers ?? [] });
	}

	listSessions(params: { cwd?: string; cursor?: string } = {}): Promise<{
		sessions: { sessionId: string; cwd: string; updatedAt: string }[];
		nextCursor?: string;
	}> {
		return this.call("session/list", params as Record<string, unknown>);
	}

	deleteSession(sessionId: string): Promise<unknown> {
		return this.call("_bodhi-pi/session/delete", { sessionId });
	}

	compactSession(params: { sessionId: string; customInstructions?: string }): Promise<{
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
	}> {
		return this.call("_bodhi-pi/session/compact", params as unknown as Record<string, unknown>) as Promise<{
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
		}>;
	}

	forkSession(params: { sessionId: string; entryId: string; position?: "before" | "at" }): Promise<{
		newSessionId: string;
		selectedText?: string;
	}> {
		return this.call("_bodhi-pi/session/fork", params as unknown as Record<string, unknown>) as Promise<{
			newSessionId: string;
			selectedText?: string;
		}>;
	}

	cloneSession(params: { sessionId: string }): Promise<{ newSessionId: string }> {
		return this.call("_bodhi-pi/session/clone", params as unknown as Record<string, unknown>) as Promise<{
			newSessionId: string;
		}>;
	}

	listSessionEntries(params: { sessionId: string }): Promise<{
		entries: { id: string; role: string; preview: string }[];
	}> {
		return this.call("_bodhi-pi/session/entries", params as unknown as Record<string, unknown>) as Promise<{
			entries: { id: string; role: string; preview: string }[];
		}>;
	}

	getSessionTree(params: { sessionId: string }): Promise<{
		leafId: string | null;
		nodes: { id: string; parentId: string | null; type: string; role?: string; preview?: string; isLeaf: boolean }[];
	}> {
		return this.call("_bodhi-pi/session/tree", params as unknown as Record<string, unknown>) as Promise<{
			leafId: string | null;
			nodes: {
				id: string;
				parentId: string | null;
				type: string;
				role?: string;
				preview?: string;
				isLeaf: boolean;
			}[];
		}>;
	}

	navigateSession(params: { sessionId: string; targetEntryId: string }): Promise<{ leafId: string }> {
		return this.call("_bodhi-pi/session/navigate", params as unknown as Record<string, unknown>) as Promise<{
			leafId: string;
		}>;
	}

	setSessionName(params: { sessionId: string; name: string }): Promise<{ ok: true; name: string }> {
		return this.call("_bodhi-pi/session/setName", params as unknown as Record<string, unknown>) as Promise<{
			ok: true;
			name: string;
		}>;
	}

	getSessionStats(params: { sessionId: string }): Promise<{
		messageCount: number;
		toolCallCount: number;
		leafId: string | null;
		name?: string;
	}> {
		return this.call("_bodhi-pi/session/stats", params as unknown as Record<string, unknown>) as Promise<{
			messageCount: number;
			toolCallCount: number;
			leafId: string | null;
			name?: string;
		}>;
	}

	exportSession(params: { sessionId: string }): Promise<{ format: string; content: string }> {
		return this.call("_bodhi-pi/session/export", params as unknown as Record<string, unknown>) as Promise<{
			format: string;
			content: string;
		}>;
	}

	getSessionConfig(params: { sessionId: string }): Promise<{
		sessionId: string;
		cwd: string;
		defaultModelId: string;
		currentModelId: string;
		compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
		appendSystemPrompt: string | null;
		contextFilePaths: string[];
	}> {
		return this.call("_bodhi-pi/session/config", params as unknown as Record<string, unknown>) as Promise<{
			sessionId: string;
			cwd: string;
			defaultModelId: string;
			currentModelId: string;
			compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
			appendSystemPrompt: string | null;
			contextFilePaths: string[];
		}>;
	}

	cancel(sessionId: string): Promise<unknown> {
		return this.call("session/cancel", { sessionId });
	}

	closeSession(sessionId: string): Promise<unknown> {
		return this.call("session/close", { sessionId });
	}

	setSessionConfigOption(params: { sessionId: string; configId: string; value: string }): Promise<{
		configOptions: { id: string; currentValue: string; options?: { value: string; name?: string }[] }[];
	}> {
		return this.call("session/setSessionConfigOption", params as unknown as Record<string, unknown>);
	}

	extMethod<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
		return this.call<T>(method, params);
	}

	private notificationHandlers = new Set<SessionNotificationHandler>();
	private lifecycleHandlers = new Set<LifecycleEventHandler>();

	onSessionUpdate(handler: SessionNotificationHandler): () => void {
		this.notificationHandlers.add(handler);
		return () => this.notificationHandlers.delete(handler);
	}

	onLifecycleEvent(handler: LifecycleEventHandler): () => void {
		this.lifecycleHandlers.add(handler);
		return () => this.lifecycleHandlers.delete(handler);
	}

	private dispatchFrame(method: string | undefined, params: unknown): void {
		if (method === "session/update") {
			const p = params as { sessionId?: string; update?: { sessionUpdate?: string } };
			if (typeof p.sessionId !== "string" || typeof p.update?.sessionUpdate !== "string") return;
			for (const h of this.notificationHandlers) h(p as Parameters<SessionNotificationHandler>[0]);
		} else if (method === LIFECYCLE_EVENT_METHOD) {
			if (params && typeof params === "object") {
				for (const h of this.lifecycleHandlers) h(params as Record<string, unknown>);
			}
		}
	}

	/**
	 * Manually fan-out a notification to handlers. Used when a JSON method
	 * (e.g. session/new) returns availableCommands captured server-side: there
	 * was no SSE channel for it, so we replay it through the notification
	 * dispatch path so useChat picks it up.
	 */
	dispatchNotificationForReplay(method: string, params: unknown): void {
		this.dispatchFrame(method, params);
	}

	private async sseCall<T>(
		method: string,
		params: Record<string, unknown>,
		opts: { signal?: AbortSignal } = {},
	): Promise<T> {
		const id = nextId++;
		const reqBody = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		this.tap("out", reqBody);
		const fetchOpts: RequestInit = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				authorization: `Bearer ${this.token}`,
			},
			body: reqBody,
		};
		if (opts.signal) fetchOpts.signal = opts.signal;
		const res = await fetch(`${this.baseUrl}/acp`, fetchOpts);
		if (!res.ok) throw new RpcError(res.status, `HTTP ${res.status} ${res.statusText}`);
		if (!res.body) throw new RpcError(0, "no response body");
		let final: T | undefined;
		for await (const frame of parseSse(res.body)) {
			this.tap("in", JSON.stringify(frame));
			const f = frame as {
				method?: string;
				params?: unknown;
				id?: unknown;
				result?: T;
				error?: { code: number; message: string; data?: unknown };
			};
			if (typeof f.method === "string") {
				this.dispatchFrame(f.method, f.params);
			} else if ("error" in f && f.error) {
				throw new RpcError(f.error.code, f.error.message, f.error.data);
			} else if ("result" in f && f.result !== undefined) {
				final = f.result;
			}
		}
		if (final === undefined) throw new RpcError(0, "SSE stream ended without final response");
		return final;
	}

	prompt(
		params: { sessionId: string; prompt: Array<{ type: string; text?: string }> },
		opts: { signal?: AbortSignal } = {},
	): Promise<{ stopReason: string }> {
		return this.sseCall<{ stopReason: string }>("session/prompt", params as unknown as Record<string, unknown>, opts);
	}

	loadSession(
		params: { sessionId: string; cwd?: string; mcpServers?: unknown[] },
		opts: { signal?: AbortSignal } = {},
	): Promise<{
		configOptions?: { id: string; currentValue: string; options?: { value: string; name?: string }[] }[];
	}> {
		return this.sseCall(
			"session/load",
			{ cwd: params.cwd ?? "/", mcpServers: params.mcpServers ?? [], ...params },
			opts,
		);
	}
}
