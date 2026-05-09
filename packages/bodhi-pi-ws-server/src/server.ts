import { createServer, type Server } from "node:http";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { type WebSocket, WebSocketServer } from "ws";
import { HandshakeAgent } from "./agent/handshake-agent.js";
import { handleAgentUpgrade, SUBPROTOCOL, type UpgradeContext } from "./auth/upgrade.js";
import { wsToStream } from "./transport/ws-stream.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface ServerHandle {
	httpServer: Server;
	close(): Promise<void>;
	port(): number;
}

export interface BuildServerOptions {
	port?: number;
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

function bindAgent(ws: WebSocket, _ctx: UpgradeContext): void {
	const stream = wsToStream(ws);
	const acpStream = ndJsonStream(stream.writable, stream.readable);
	new AgentSideConnection(() => new HandshakeAgent(), acpStream);
	setupHeartbeat(ws);
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<ServerHandle> {
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

	httpServer.on("upgrade", (req, socket, head) => {
		if (req.url !== "/agent") {
			socket.destroy();
			return;
		}
		handleAgentUpgrade(wss, req, socket, head, bindAgent);
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
		},
	};
}
