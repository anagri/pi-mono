import { createServer, type Server } from "node:http";
import path from "node:path";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import type Database from "better-sqlite3";
import { type WebSocket, WebSocketServer } from "ws";
import { wireAgentForConnection } from "./agent/wire-agent.js";
import { handleAgentUpgrade, SUBPROTOCOL, type UpgradeContext } from "./auth/upgrade.js";
import { type Db, openDb, upsertUser } from "./sessions/sqlite-session-store.js";
import { wsToStream } from "./transport/ws-stream.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface BuildServerOptions {
	port?: number;
	dataDir: string;
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	systemPrompt?: string;
	/** Single-tenant override: every connection uses this dir as cwd. */
	workspaceOverride?: string;
}

export interface ServerHandle {
	httpServer: Server;
	close(): Promise<void>;
	port(): number;
	db: Db;
}

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

export async function buildServer(opts: BuildServerOptions): Promise<ServerHandle> {
	const dbPath = path.resolve(opts.dataDir, "sessions.db");
	const { db, sqlite } = openDb({ dbPath });

	const httpServer = createServer((req, res) => {
		if (req.url === "/healthz") {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("ok");
			return;
		}
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
	});

	const wss = new WebSocketServer({
		noServer: true,
		handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
	});

	async function bindAgent(ws: WebSocket, ctx: UpgradeContext): Promise<void> {
		upsertUser(db, ctx.user);
		const stream = wsToStream(ws);
		const acpStream = ndJsonStream(stream.writable, stream.readable);
		const factory = await wireAgentForConnection({
			user: ctx.user,
			dataDir: opts.dataDir,
			db,
			models: opts.models,
			defaultModelId: opts.defaultModelId,
			getApiKey: opts.getApiKey,
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
		});
		new AgentSideConnection(factory, acpStream);
		setupHeartbeat(ws);
	}

	httpServer.on("upgrade", (req, socket, head) => {
		if (req.url !== "/agent") {
			socket.destroy();
			return;
		}
		handleAgentUpgrade(wss, req, socket, head, (ws, ctx) => {
			void bindAgent(ws, ctx).catch((err) => {
				console.error("[bodhi-pi-ws-server] failed to bind agent:", err);
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
