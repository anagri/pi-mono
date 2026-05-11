import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type Database from "better-sqlite3";
import { createAcpHandler } from "./acp/handler.js";
import { type Db, openDb } from "./sessions/sqlite-session-store.js";
import { createStaticHandler, type StaticHandler } from "./static.js";

export interface BuildServerOptions {
	port?: number;
	dataDir: string;
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	/** Single-tenant override: every request uses this dir as cwd. */
	workspaceOverride?: string;
	/** Directory to serve static assets from. Defaults to the package's `dist/public`. Set to `null` to disable. */
	staticDir?: string | null;
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

	const handleAcp = createAcpHandler({
		dataDir: opts.dataDir,
		db,
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		getApiKey: opts.getApiKey,
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
		...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
	});

	const here = path.dirname(fileURLToPath(import.meta.url));
	const defaultStaticDir = path.resolve(here, "..", "..", "dist", "public");
	const staticDir = opts.staticDir === null ? null : (opts.staticDir ?? defaultStaticDir);
	const serveStatic: StaticHandler | undefined = staticDir ? createStaticHandler(staticDir) : undefined;

	const httpServer = createServer((req, res) => {
		void handleRequest(req, res, handleAcp, serveStatic).catch((err) => {
			console.error("[bodhi-pi-http] request handler error:", err);
			if (!res.headersSent) {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end("internal server error\n");
			}
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
