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
 */
import { parseSse } from "./sse-parser.ts";

export type SessionNotificationHandler = (notification: {
	sessionId: string;
	update: { sessionUpdate: string; [k: string]: unknown };
}) => void;

export interface AcpClientConfig {
	/** Token already encoded as base64url JSON. */
	token: string;
	/** Base URL of the server, e.g. `""` (same origin) or `http://localhost:3000`. */
	baseUrl?: string;
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

let nextId = 1;

export class AcpHttpClient {
	private readonly baseUrl: string;
	private readonly token: string;

	constructor(cfg: AcpClientConfig) {
		this.baseUrl = cfg.baseUrl ?? "";
		this.token = cfg.token;
	}

	private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
		const id = nextId++;
		const res = await fetch(`${this.baseUrl}/acp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		});
		if (!res.ok) {
			throw new RpcError(res.status, `HTTP ${res.status} ${res.statusText}`);
		}
		const body = (await res.json()) as JsonRpcSuccess<T> | JsonRpcError;
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

	newSession(params: { cwd?: string; mcpServers?: unknown[] } = {}): Promise<{ sessionId: string }> {
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

	cancel(sessionId: string): Promise<unknown> {
		return this.call("session/cancel", { sessionId });
	}

	private notificationHandlers = new Set<SessionNotificationHandler>();

	onSessionUpdate(handler: SessionNotificationHandler): () => void {
		this.notificationHandlers.add(handler);
		return () => this.notificationHandlers.delete(handler);
	}

	private dispatchNotification(method: string, params: unknown): void {
		if (method !== "session/update") return;
		const p = params as { sessionId?: string; update?: { sessionUpdate?: string } };
		if (typeof p.sessionId !== "string" || typeof p.update?.sessionUpdate !== "string") return;
		for (const h of this.notificationHandlers) h(p as Parameters<SessionNotificationHandler>[0]);
	}

	private async sseCall<T>(
		method: string,
		params: Record<string, unknown>,
		opts: { signal?: AbortSignal } = {},
	): Promise<T> {
		const id = nextId++;
		const fetchOpts: RequestInit = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		};
		if (opts.signal) fetchOpts.signal = opts.signal;
		const res = await fetch(`${this.baseUrl}/acp`, fetchOpts);
		if (!res.ok) throw new RpcError(res.status, `HTTP ${res.status} ${res.statusText}`);
		if (!res.body) throw new RpcError(0, "no response body");
		let final: T | undefined;
		for await (const frame of parseSse(res.body)) {
			const f = frame as {
				method?: string;
				params?: unknown;
				id?: unknown;
				result?: T;
				error?: { code: number; message: string; data?: unknown };
			};
			if (typeof f.method === "string") {
				this.dispatchNotification(f.method, f.params);
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
	): Promise<unknown> {
		return this.sseCall(
			"session/load",
			{ cwd: params.cwd ?? "/", mcpServers: params.mcpServers ?? [], ...params },
			opts,
		);
	}
}
