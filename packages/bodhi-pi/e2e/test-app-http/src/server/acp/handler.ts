import type { IncomingMessage, ServerResponse } from "node:http";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type WireAgentResult, wireAgentForRequest } from "../agent/wire-agent.js";
import { authenticateRequest, reject401 } from "../auth/middleware.js";
import { type Db, upsertUser } from "../sessions/sqlite-session-store.js";
import { createHttpAcpConn } from "./http-acp-conn.js";
import { createInflightRegistry, type InflightRegistry } from "./inflight.js";
import { writeSseEvent, writeSseHeaders } from "./sse.js";

export interface AcpHandlerOptions {
	dataDir: string;
	db: Db;
	models?: Model<Api>[];
	defaultModelId?: string;
	getApiKey?: (provider: string) => string | undefined;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	workspaceOverride?: string;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: number | string | null;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
	jsonrpc: "2.0";
	id: number | string | null;
	result: unknown;
}

interface JsonRpcError {
	jsonrpc: "2.0";
	id: number | string | null;
	error: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.length === 0) throw new Error("empty body");
	return JSON.parse(raw);
}

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
	return (
		typeof v === "object" &&
		v !== null &&
		(v as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
		typeof (v as { method?: unknown }).method === "string"
	);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
	});
	res.end(text);
}

function rpcError(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcError {
	return data === undefined
		? { jsonrpc: "2.0", id, error: { code, message } }
		: { jsonrpc: "2.0", id, error: { code, message, data } };
}

function rpcSuccess(id: number | string | null, result: unknown): JsonRpcSuccess {
	return { jsonrpc: "2.0", id, result };
}

const SSE_METHODS = new Set(["session/prompt", "session/load"]);

export function createAcpHandler(opts: AcpHandlerOptions) {
	const inflight = createInflightRegistry();
	return async function handleAcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== "POST") {
			writeJson(res, 405, rpcError(null, INVALID_REQUEST, "POST required"));
			return;
		}

		// Auth at the seam.
		let user: ReturnType<typeof authenticateRequest>;
		try {
			user = authenticateRequest(req);
		} catch {
			reject401(res);
			return;
		}

		// Parse body.
		let body: unknown;
		try {
			body = await readJsonBody(req);
		} catch (err) {
			writeJson(res, 200, rpcError(null, PARSE_ERROR, err instanceof Error ? err.message : "parse error"));
			return;
		}
		if (!isJsonRpcRequest(body)) {
			writeJson(res, 200, rpcError(null, INVALID_REQUEST, "not a valid JSON-RPC 2.0 request"));
			return;
		}
		const id = body.id ?? null;
		const params = body.params ?? {};

		// Build per-request agent. Note: building extensions per request — accepted cost (see plan).
		upsertUser(opts.db, user);
		const wired = await wireAgentForRequest({
			user,
			dataDir: opts.dataDir,
			db: opts.db,
			...(opts.models !== undefined ? { models: opts.models } : {}),
			...(opts.defaultModelId !== undefined ? { defaultModelId: opts.defaultModelId } : {}),
			...(opts.getApiKey !== undefined ? { getApiKey: opts.getApiKey } : {}),
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
			...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
		});

		if (SSE_METHODS.has(body.method)) {
			await handleSseMethod(res, wired, body.method, params, id, inflight);
			return;
		}

		// Cancel notification (typed in ACP as a notification with no response, but we
		// support it as a JSON method that returns {}). Looks up inflight + aborts.
		if (body.method === "session/cancel") {
			const sid = (params as { sessionId?: unknown }).sessionId;
			if (typeof sid === "string") inflight.abort(sid);
			writeJson(res, 200, rpcSuccess(id, {}));
			return;
		}

		// Capture sessionUpdate notifications fired during JSON dispatch (e.g.
		// `available_commands_update` during newSession) so we can inject them
		// into the JSON response. Without this, project commands + skills would
		// never reach the client because JSON methods don't have an SSE channel.
		let capturedAvailableCommands: unknown[] | undefined;
		const conn = createHttpAcpConn({
			onNotification: (notification) => {
				const n = notification as { update?: { sessionUpdate?: string; availableCommands?: unknown[] } };
				if (n.update?.sessionUpdate === "available_commands_update" && Array.isArray(n.update.availableCommands)) {
					capturedAvailableCommands = n.update.availableCommands;
				}
			},
		});
		const agent = wired.factory(conn);

		try {
			// Each HTTP request gets a fresh agent with no in-memory SessionState.
			// Any method whose params carry a sessionId is treated as session-bound
			// and rehydrated up-front, matching the stateful-agent assumption the
			// rest of the bodhi-pi contract makes. The SSE path (handleSseMethod)
			// applies the same rule for session/prompt and session/load.
			const sid = (params as { sessionId?: unknown }).sessionId;
			if (typeof sid === "string" && agent.resumeSession) {
				await agent.resumeSession({ sessionId: sid, cwd: wired.cwd, mcpServers: [] } as never);
			}
			const result = await dispatchJsonMethod(agent, body.method, params);
			// Inject captured availableCommands into newSession's response so the
			// client can populate /help with project commands without an SSE round-trip.
			const augmented =
				body.method === "session/new" && capturedAvailableCommands && typeof result === "object" && result !== null
					? { ...(result as Record<string, unknown>), availableCommands: capturedAvailableCommands }
					: result;
			writeJson(res, 200, rpcSuccess(id, augmented));
		} catch (err) {
			if (err instanceof MethodNotFoundError) {
				writeJson(res, 200, rpcError(id, METHOD_NOT_FOUND, err.message));
				return;
			}
			if (
				typeof err === "object" &&
				err !== null &&
				"code" in err &&
				typeof (err as { code: unknown }).code === "number"
			) {
				const e = err as { code: number; message?: string; data?: unknown };
				writeJson(res, 200, rpcError(id, e.code, e.message ?? "request error", e.data));
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			writeJson(res, 200, rpcError(id, INTERNAL_ERROR, message));
		}
	};
}

async function handleSseMethod(
	res: ServerResponse,
	wired: WireAgentResult,
	method: string,
	params: Record<string, unknown>,
	id: number | string | null,
	inflight: InflightRegistry,
): Promise<void> {
	writeSseHeaders(res);
	const sessionId =
		typeof (params as { sessionId?: unknown }).sessionId === "string"
			? (params as { sessionId: string }).sessionId
			: undefined;

	const conn = createHttpAcpConn({
		onNotification: (notification) => {
			writeSseEvent(res, { jsonrpc: "2.0", method: "session/update", params: notification });
		},
		onExtNotification: (notifMethod, notifParams) => {
			writeSseEvent(res, { jsonrpc: "2.0", method: notifMethod, params: notifParams });
		},
	});

	const ctrl = sessionId ? inflight.register(sessionId) : new AbortController();
	const onClose = () => {
		if (sessionId) inflight.abort(sessionId);
		else ctrl.abort("client-closed");
	};
	res.on("close", onClose);

	try {
		const agent = wired.factory(conn);

		if (method === "session/prompt") {
			// Each fresh agent has no in-memory state for this session — transparently
			// rehydrate from store before invoking prompt.
			if (!sessionId) {
				throw new Error("session/prompt: sessionId is required");
			}
			if (agent.resumeSession) {
				await agent.resumeSession({ sessionId, cwd: wired.cwd, mcpServers: [] } as never);
			}
			// When the inflight controller aborts (cancel notification or client close),
			// translate into the agent's own cancel call so it produces a final
			// `stopReason: "cancelled"` response.
			ctrl.signal.addEventListener(
				"abort",
				() => {
					void agent.cancel({ sessionId } as never).catch(() => {});
				},
				{ once: true },
			);
			const result = await agent.prompt(params as never);
			writeSseEvent(res, { jsonrpc: "2.0", id, result });
		} else if (method === "session/load") {
			if (!agent.loadSession) {
				throw new Error("session/load: not supported");
			}
			const result = await agent.loadSession(params as never);
			writeSseEvent(res, { jsonrpc: "2.0", id, result });
		} else {
			throw new Error(`SSE method not implemented: ${method}`);
		}
	} catch (err) {
		const code =
			typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "number"
				? (err as { code: number }).code
				: INTERNAL_ERROR;
		const message = err instanceof Error ? err.message : String(err);
		writeSseEvent(res, { jsonrpc: "2.0", id, error: { code, message } });
	} finally {
		if (sessionId) inflight.release(sessionId);
		res.off("close", onClose);
		res.end();
	}
}

class MethodNotFoundError extends Error {}

async function dispatchJsonMethod(
	agent: ReturnType<WireAgentResult["factory"]>,
	method: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	switch (method) {
		case "initialize":
			return await agent.initialize(params as never);
		case "authenticate":
			return (await agent.authenticate(params as never)) ?? {};
		case "session/new":
			return await agent.newSession(params as never);
		case "session/list": {
			if (!agent.listSessions) throw new MethodNotFoundError("session/list not supported");
			return await agent.listSessions(params as never);
		}
		case "session/close": {
			if (!agent.closeSession) throw new MethodNotFoundError("session/close not supported");
			return (await agent.closeSession(params as never)) ?? {};
		}
		case "session/setSessionConfigOption": {
			if (!agent.setSessionConfigOption)
				throw new MethodNotFoundError("session/setSessionConfigOption not supported");
			return await agent.setSessionConfigOption(params as never);
		}
		default: {
			// Extension methods (e.g. `_bodhi-pi/session/delete`) route through the
			// agent's extMethod hook. The agent throws RequestError(-32601) if it
			// doesn't recognize the method — we surface that as JSON-RPC method-not-found.
			if (agent.extMethod) {
				return await agent.extMethod(method, params);
			}
			throw new MethodNotFoundError(`method not found: ${method}`);
		}
	}
}
