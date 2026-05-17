import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { type Db, openDb, upsertUser } from "@bodhiapp/bodhi-pi-test-app-node-adapters";
import type { Api, Model } from "@earendil-works/pi-ai";
import type Database from "better-sqlite3";
import { type WebSocket, WebSocketServer } from "ws";
import { createAcpHandler } from "./acp/handler.js";
import { wireAgentForWsConnection } from "./agent/wire-agent-ws.js";
import { handleAgentUpgrade, SUBPROTOCOL, type UpgradeContext } from "./auth/upgrade.js";
import { ServerMcpStore } from "./mcp/server-mcp-store.js";
import { handleOauthCallback } from "./oauth-callback.js";
import { handleProvision } from "./provision.js";
import { createStaticHandler, type StaticHandler } from "./static.js";
import { wsToStream } from "./transport/ws-stream.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

function setupHeartbeat(ws: WebSocket): void {
	let alive = true;
	ws.on("pong", () => {
		alive = true;
	});
	const interval = setInterval(() => {
		if (!alive) {
			ws.terminate();
			return;
		}
		alive = false;
		ws.ping();
	}, HEARTBEAT_INTERVAL_MS);
	ws.on("close", () => clearInterval(interval));
}

export interface BuildServerOptions {
	port?: number;
	dataDir: string;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	/** Host-additive models (faux providers for tests, local LLMs for production). */
	models?: Model<Api>[];
	/** Optional default model id. When unset, the agent picks the first auth-available model. */
	defaultModelId?: string;
	/** Optional pre-kvStore fallback; production passes nothing, tests pass `() => "test-key"` for faux. */
	getApiKey?: (provider: string) => string | undefined;
	/** Single-tenant override: every request uses this dir as cwd. */
	workspaceOverride?: string;
	/** Directory to serve static assets from. Defaults to the package's `dist/public`. Set to `null` to disable. */
	staticDir?: string | null;
	/**
	 * Public base URL for the server (used to compose oauth-preregistered redirect_uri). When unset,
	 * the OAuth handler falls back to the inbound request's `Host` header.
	 */
	publicBaseUrl?: string;
}

export interface ServerHandle {
	httpServer: Server;
	close(): Promise<void>;
	port(): number;
	db: Db;
}

export async function buildServer(opts: BuildServerOptions): Promise<ServerHandle> {
	const dbPath = path.resolve(opts.dataDir, "sessions.db");
	const { db, sqlite } = openDb({ dbPath });

	// Single server-process-scoped MCP store: per-user connections survive
	// per-request agent rebuild for /acp (and the same store is reused for
	// /acp-ws in slice 4 so page-refresh-via-ws also keeps connections).
	const mcpStore = new ServerMcpStore();

	const handleAcp = createAcpHandler({
		dataDir: opts.dataDir,
		db,
		mcpStore,
		...(opts.models !== undefined ? { models: opts.models } : {}),
		...(opts.defaultModelId !== undefined ? { defaultModelId: opts.defaultModelId } : {}),
		...(opts.getApiKey !== undefined ? { getApiKey: opts.getApiKey } : {}),
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
		...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
	});

	const here = path.dirname(fileURLToPath(import.meta.url));
	// `here` (built): <test-app-http>/dist/
	// dist/public lives at: <test-app-http>/dist/public/
	const defaultStaticDir = path.resolve(here, "public");
	const staticDir = opts.staticDir === null ? null : (opts.staticDir ?? defaultStaticDir);
	const serveStatic: StaticHandler | undefined = staticDir ? createStaticHandler(staticDir) : undefined;

	const provisionOpts: { dataDir: string; workspaceOverride?: string } = { dataDir: opts.dataDir };
	if (opts.workspaceOverride !== undefined) provisionOpts.workspaceOverride = opts.workspaceOverride;

	const oauthOpts = { dataDir: opts.dataDir };

	const httpServer = createServer((req, res) => {
		void handleRequest(req, res, handleAcp, serveStatic, provisionOpts, oauthOpts).catch((err) => {
			console.error("[bodhi-pi-http] request handler error:", err);
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end("internal server error\n");
			}
		});
	});

	// WebSocket transport on /acp-ws: per-connection stateful agent lifecycle.
	// Auth via Sec-WebSocket-Protocol bearer subprotocol; agent stays alive for
	// the connection. Differs from /acp (HTTP+SSE per-turn rebuild).
	const wss = new WebSocketServer({
		noServer: true,
		handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
	});

	async function bindWsAgent(ws: WebSocket, ctx: UpgradeContext): Promise<void> {
		upsertUser(db, ctx.user);
		const stream = wsToStream(ws);
		const acpStream = ndJsonStream(stream.writable, stream.readable);
		const wired = await wireAgentForWsConnection({
			user: ctx.user,
			dataDir: opts.dataDir,
			db,
			mcpStore,
			...(opts.models !== undefined ? { models: opts.models } : {}),
			...(opts.defaultModelId !== undefined ? { defaultModelId: opts.defaultModelId } : {}),
			...(opts.getApiKey !== undefined ? { getApiKey: opts.getApiKey } : {}),
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
			...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
		});
		new AgentSideConnection(wired.factory, acpStream);
		setupHeartbeat(ws);
	}

	httpServer.on("upgrade", (req, socket, head) => {
		if (req.url !== "/acp-ws") {
			socket.destroy();
			return;
		}
		handleAgentUpgrade(wss, req, socket, head, (ws, ctx) => {
			void bindWsAgent(ws, ctx).catch((err) => {
				console.error("[bodhi-pi-test-app-http ws] failed to bind agent:", err);
				ws.terminate();
			});
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			httpServer.off("listening", onListening);
			reject(err);
		};
		const onListening = () => {
			httpServer.off("error", onError);
			resolve();
		};
		httpServer.once("error", onError);
		httpServer.once("listening", onListening);
		httpServer.listen(opts.port ?? 0);
	});

	return {
		httpServer,
		db,
		port() {
			const addr = httpServer.address();
			if (typeof addr === "object" && addr !== null) return addr.port;
			throw new Error("server not listening");
		},
		async close() {
			for (const ws of wss.clients) {
				ws.terminate();
			}
			wss.close();
			await new Promise<void>((resolve, reject) => {
				httpServer.close((err) => (err ? reject(err) : resolve()));
			});
			(sqlite as Database.Database).close();
		},
	};
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	handleAcp: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
	serveStatic: StaticHandler | undefined,
	provisionOpts: { dataDir: string; workspaceOverride?: string },
	oauthOpts: { dataDir: string },
): Promise<void> {
	if (req.url === "/healthz") {
		const body = "ok";
		res.writeHead(200, {
			"content-type": "text/plain; charset=utf-8",
			"content-length": Buffer.byteLength(body),
		});
		res.end(body);
		return;
	}

	if (req.url === "/acp") {
		await handleAcp(req, res);
		return;
	}

	if (req.url?.startsWith("/oauth/callback") && req.method === "GET") {
		await handleOauthCallback(req, res, oauthOpts);
		return;
	}

	if (req.url === "/provision" && req.method === "POST") {
		await handleProvision(req, res, provisionOpts);
		return;
	}

	if (serveStatic?.(req, res)) {
		return;
	}

	const body = "not found\n";
	res.writeHead(404, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}
