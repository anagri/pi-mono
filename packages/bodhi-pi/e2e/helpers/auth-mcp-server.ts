import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * Spin up a tiny HTTP-streamable MCP server that REQUIRES one of:
 *   - `Authorization: Bearer <token>` header, OR
 *   - `?api_key=<token>` query parameter
 *
 * Used by the bodhi-pi auth e2e suite to verify that the http-param auth mode
 * actually attaches headers + queries on outbound requests. Listens on
 * `0.0.0.0:<port>` and exposes a single `whoami` tool whose result echoes how the
 * caller authenticated. Caller owns the returned server and must `close()` on teardown.
 */
export interface AuthMcpServerHandle {
	url: string;
	close(): Promise<void>;
}

export async function spawnAuthMcpServer(port: number, token: string): Promise<AuthMcpServerHandle> {
	const transports = new Map<string, StreamableHTTPServerTransport>();

	function buildMcpServer(authVia: "header" | "query"): McpServer {
		const mcp = new McpServer({ name: "bodhi-pi-e2e-auth-server", version: "0.0.1" });
		mcp.registerTool(
			"whoami",
			{
				description: "Returns how the caller authenticated. Use this to verify the server received credentials.",
				inputSchema: {},
			},
			async () => ({
				content: [{ type: "text", text: `authenticated via ${authVia}` }],
			}),
		);
		return mcp;
	}

	function readJsonBody(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
			req.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				if (raw.length === 0) {
					resolve(undefined);
					return;
				}
				try {
					resolve(JSON.parse(raw));
				} catch (err) {
					reject(err);
				}
			});
			req.on("error", reject);
		});
	}

	function checkAuth(req: IncomingMessage): { ok: true; via: "header" | "query" } | { ok: false; reason: string } {
		const auth = req.headers.authorization;
		if (typeof auth === "string" && auth.startsWith("Bearer ")) {
			return auth.slice("Bearer ".length) === token
				? { ok: true, via: "header" }
				: { ok: false, reason: "bad bearer token" };
		}
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const apiKey = url.searchParams.get("api_key");
		if (apiKey !== null) {
			return apiKey === token ? { ok: true, via: "query" } : { ok: false, reason: "bad api_key" };
		}
		return { ok: false, reason: "missing auth (need Authorization header or api_key query)" };
	}

	const corsHeaders = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
		"Access-Control-Expose-Headers": "Mcp-Session-Id",
		"Access-Control-Max-Age": "86400",
	};

	const server: Server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://localhost:${port}`);
			if (url.pathname !== "/mcp") {
				res.writeHead(404, corsHeaders).end();
				return;
			}
			// Preflight: browsers/chrome-ext workers issue OPTIONS before POSTing JSON.
			if (req.method === "OPTIONS") {
				res.writeHead(204, corsHeaders).end();
				return;
			}
			for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);
			const authResult = checkAuth(req);
			if (!authResult.ok) {
				res.writeHead(401, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32001, message: `unauthorized: ${authResult.reason}` },
						id: null,
					}),
				);
				return;
			}

			const sessionIdHeader = req.headers["mcp-session-id"];
			const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

			if (req.method === "POST") {
				const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
				let transport = sessionId ? transports.get(sessionId) : undefined;
				if (!transport) {
					if (!isInitializeRequest(body)) {
						res.writeHead(400, { "Content-Type": "application/json" }).end(
							JSON.stringify({
								jsonrpc: "2.0",
								error: { code: -32000, message: "expected initialize as first request" },
								id: null,
							}),
						);
						return;
					}
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						onsessioninitialized: (sid) => {
							if (transport) transports.set(sid, transport);
						},
					});
					transport.onclose = () => {
						const sid = transport?.sessionId;
						if (sid) transports.delete(sid);
					};
					const mcp = buildMcpServer(authResult.via);
					await mcp.connect(transport);
				}
				await transport.handleRequest(req, res, body);
				return;
			}

			// GET / DELETE are session-id required (resume stream or close).
			if (!sessionId || !transports.has(sessionId)) {
				res.writeHead(400, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32000, message: "missing or unknown session id" },
						id: null,
					}),
				);
				return;
			}
			await transports.get(sessionId)!.handleRequest(req, res);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						jsonrpc: "2.0",
						error: { code: -32603, message: `auth-mcp-server: ${msg}` },
						id: null,
					}),
				);
			}
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});

	return {
		url: `http://localhost:${port}/mcp`,
		close: async () => {
			for (const t of transports.values()) {
				try {
					await t.close();
				} catch {
					// best-effort
				}
			}
			transports.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
