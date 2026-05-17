import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tiny OAuth 2.1 authorization-code-with-PKCE provider + MCP server, in one process. Designed
 * to mirror `auth-mcp-server.ts` so the bodhi-pi e2e suite can drive a full OAuth round trip
 * without external dependencies.
 *
 * Endpoints:
 *   - `GET /authorize`  — accepts standard PKCE params; with `?auto=1` redirects immediately,
 *                          otherwise renders a 1-button HTML approve page.
 *   - `POST /authorize/approve`  — completes the approval click; redirects to redirect_uri.
 *   - `POST /token`     — exchanges code for access+refresh tokens (validates PKCE).
 *   - `POST /mcp`       — MCP transport, requires `Authorization: Bearer <access>`.
 *
 * Supports both `client_secret_basic` (Authorization header) and `client_secret_post` (body),
 * which lets the same fixture exercise both `tokenAuthMethod` settings.
 */
export interface OAuthMcpServerHandle {
	url: string;
	mcpUrl: string;
	authorizeUrl: string;
	tokenUrl: string;
	/** RFC 7591 DCR endpoint exposed by the fixture. */
	registrationEndpoint: string;
	/** Static pre-registered client; DCR-registered clients live alongside it. */
	clientId: string;
	clientSecret: string;
	close(): Promise<void>;
	/** Returns the count of distinct Bearer tokens the `/mcp` endpoint has seen — refresh tests poll this to assert a new token was minted. */
	uniqueBearerCount(): number;
	/** Count of clients in the fixture's registry (default + DCR-registered). */
	registeredClientCount(): number;
}

export interface SpawnOAuthMcpServerOptions {
	port: number;
	clientId?: string;
	clientSecret?: string;
	/** When set, every issued token has `expires_in` = this value (in seconds). Refresh tests use `1`. */
	expiresInSeconds?: number;
}

interface PendingAuthCode {
	code: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	codeChallengeMethod: string;
	state: string;
	scope?: string;
}

export async function spawnOAuthMcpServer(opts: SpawnOAuthMcpServerOptions): Promise<OAuthMcpServerHandle> {
	const defaultClientId = opts.clientId ?? "oauth-e2e-client";
	const defaultClientSecret = opts.clientSecret ?? "oauth-e2e-secret-7q3";
	const expiresIn = opts.expiresInSeconds ?? 3600;
	const transports = new Map<string, StreamableHTTPServerTransport>();
	const pendingCodes = new Map<string, PendingAuthCode>();
	const accessTokens = new Map<string, { expiresAt: number; refreshToken: string }>();
	const refreshTokens = new Map<string, true>();
	const seenBearers = new Set<string>();
	// DCR-registered clients live alongside the default static pair. Keyed by client_id.
	const registeredClients = new Map<string, { clientSecret: string }>();
	registeredClients.set(defaultClientId, { clientSecret: defaultClientSecret });

	const baseUrl = `http://localhost:${opts.port}`;

	const corsHeaders = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
		// Expose `Location` so cross-origin callers (chrome-ext Playwright stub) can read the
		// `?auto=1` redirect target from a `redirect: "manual"` fetch — without this Chrome
		// hides the header and the stub can't extract code+state.
		"Access-Control-Expose-Headers": "Mcp-Session-Id, Location",
		"Access-Control-Max-Age": "86400",
	};

	function applyCors(res: ServerResponse): void {
		for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);
	}

	function readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			req.on("error", reject);
		});
	}

	function buildMcp(): McpServer {
		const mcp = new McpServer({ name: "bodhi-pi-e2e-oauth-server", version: "0.0.1" });
		mcp.registerTool(
			"whoami",
			{
				description: "Returns 'authenticated via bearer' after a successful OAuth exchange.",
				inputSchema: {},
			},
			async () => ({
				content: [{ type: "text", text: "authenticated via bearer" }],
			}),
		);
		return mcp;
	}

	function constantEq(a: string, b: string): boolean {
		const aBuf = Buffer.from(a);
		const bBuf = Buffer.from(b);
		if (aBuf.length !== bBuf.length) return false;
		return timingSafeEqual(aBuf, bBuf);
	}

	function parseBasicAuth(header: string | undefined): { id: string; secret: string } | null {
		if (!header || !header.startsWith("Basic ")) return null;
		try {
			const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
			const idx = decoded.indexOf(":");
			if (idx === -1) return null;
			return {
				id: decodeURIComponent(decoded.slice(0, idx)),
				secret: decodeURIComponent(decoded.slice(idx + 1)),
			};
		} catch {
			return null;
		}
	}

	function pkceMatch(challenge: string, verifier: string, method: string): boolean {
		if (method === "plain") return challenge === verifier;
		const computed = createHash("sha256").update(verifier).digest("base64url");
		return computed === challenge;
	}

	async function handleAuthorize(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const responseType = url.searchParams.get("response_type");
		const incomingClientId = url.searchParams.get("client_id");
		const redirectUri = url.searchParams.get("redirect_uri");
		const codeChallenge = url.searchParams.get("code_challenge");
		const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";
		const state = url.searchParams.get("state") ?? "";
		const scope = url.searchParams.get("scope") ?? undefined;
		const auto = url.searchParams.get("auto") === "1";

		if (responseType !== "code" || !incomingClientId || !redirectUri || !codeChallenge) {
			res.writeHead(400, { "Content-Type": "text/plain" }).end("invalid authorize params");
			return;
		}
		if (!registeredClients.has(incomingClientId)) {
			res.writeHead(400, { "Content-Type": "text/plain" }).end(`unknown client_id ${incomingClientId}`);
			return;
		}

		const code = randomBytes(16).toString("base64url");
		pendingCodes.set(code, {
			code,
			clientId: incomingClientId,
			redirectUri,
			codeChallenge,
			codeChallengeMethod,
			state,
			...(scope !== undefined ? { scope } : {}),
		});

		if (auto) {
			const redirect = new URL(redirectUri);
			redirect.searchParams.set("code", code);
			if (state) redirect.searchParams.set("state", state);
			// `?auto=1&respond=json` returns the redirect URL in a CORS-readable JSON body
			// instead of a 302. Necessary for the chrome-ext Playwright stub because browser
			// fetch with `redirect: "manual"` always produces an opaqueredirect response with
			// no readable headers cross-origin — Location can't be extracted that way.
			if (url.searchParams.get("respond") === "json") {
				const body = JSON.stringify({ redirectUri: redirect.toString(), code, state });
				res.writeHead(200, {
					...corsHeaders,
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				}).end(body);
				return;
			}
			res.writeHead(302, { Location: redirect.toString() }).end();
			return;
		}

		// Manual approve page (used by Playwright tests).
		const approveUrl = `${baseUrl}/authorize/approve?code=${encodeURIComponent(code)}`;
		const html = `<!doctype html><html><body><h2>Approve OAuth?</h2><form method="POST" action="${approveUrl}"><button type="submit">Approve</button></form></body></html>`;
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
	}

	async function handleAuthorizeApprove(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		const code = url.searchParams.get("code");
		const pending = code ? pendingCodes.get(code) : undefined;
		if (!pending) {
			res.writeHead(400, { "Content-Type": "text/plain" }).end("unknown code");
			return;
		}
		const redirect = new URL(pending.redirectUri);
		redirect.searchParams.set("code", code!);
		if (pending.state) redirect.searchParams.set("state", pending.state);
		res.writeHead(302, { Location: redirect.toString() }).end();
	}

	async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readBody(req);
		const params = new URLSearchParams(body);
		const grantType = params.get("grant_type");

		// Authenticate the client — supports both client_secret_basic and client_secret_post.
		let presentedId: string | undefined;
		let presentedSecret: string | undefined;
		const basic = parseBasicAuth(req.headers.authorization);
		if (basic) {
			presentedId = basic.id;
			presentedSecret = basic.secret;
		} else if (params.get("client_id")) {
			presentedId = params.get("client_id") ?? undefined;
			presentedSecret = params.get("client_secret") ?? undefined;
		}
		const expected = presentedId ? registeredClients.get(presentedId) : undefined;
		if (!presentedId || !expected || !presentedSecret || !constantEq(presentedSecret, expected.clientSecret)) {
			res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_client" }));
			return;
		}

		if (grantType === "authorization_code") {
			const code = params.get("code") ?? "";
			const codeVerifier = params.get("code_verifier") ?? "";
			const redirectUri = params.get("redirect_uri") ?? "";
			const pending = pendingCodes.get(code);
			if (!pending) {
				res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
				return;
			}
			pendingCodes.delete(code);
			if (pending.redirectUri !== redirectUri) {
				res.writeHead(400, { "Content-Type": "application/json" }).end(
					JSON.stringify({ error: "invalid_grant", error_description: "redirect_uri mismatch" }),
				);
				return;
			}
			if (!pkceMatch(pending.codeChallenge, codeVerifier, pending.codeChallengeMethod)) {
				res.writeHead(400, { "Content-Type": "application/json" }).end(
					JSON.stringify({ error: "invalid_grant", error_description: "PKCE verifier mismatch" }),
				);
				return;
			}
			issueTokens(res);
			return;
		}

		if (grantType === "refresh_token") {
			const rt = params.get("refresh_token") ?? "";
			if (!refreshTokens.has(rt)) {
				res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
				return;
			}
			refreshTokens.delete(rt);
			issueTokens(res);
			return;
		}

		res.writeHead(400, { "Content-Type": "application/json" }).end(
			JSON.stringify({ error: "unsupported_grant_type" }),
		);
	}

	function issueTokens(res: ServerResponse): void {
		const accessToken = randomBytes(20).toString("base64url");
		const refreshToken = randomBytes(20).toString("base64url");
		accessTokens.set(accessToken, { expiresAt: Date.now() + expiresIn * 1000, refreshToken });
		refreshTokens.set(refreshToken, true);
		res.writeHead(200, { "Content-Type": "application/json" }).end(
			JSON.stringify({
				access_token: accessToken,
				refresh_token: refreshToken,
				token_type: "Bearer",
				expires_in: expiresIn,
			}),
		);
	}

	async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		applyCors(res);
		if (req.method === "OPTIONS") {
			res.writeHead(204).end();
			return;
		}
		const authHeader = req.headers.authorization;
		const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
		if (!bearer || !accessTokens.has(bearer)) {
			res.writeHead(401, { "Content-Type": "application/json" }).end(
				JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }),
			);
			return;
		}
		seenBearers.add(bearer);

		const sessionIdHeader = req.headers["mcp-session-id"];
		const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

		if (req.method === "POST") {
			const body = await readBody(req);
			const parsed = body.length > 0 ? JSON.parse(body) : undefined;
			let transport = sessionId ? transports.get(sessionId) : undefined;
			if (!transport) {
				if (!isInitializeRequest(parsed)) {
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
					sessionIdGenerator: () => randomBytes(16).toString("hex"),
					onsessioninitialized: (sid) => {
						if (transport) transports.set(sid, transport);
					},
				});
				transport.onclose = () => {
					const sid = transport?.sessionId;
					if (sid) transports.delete(sid);
				};
				await buildMcp().connect(transport);
			}
			await transport.handleRequest(req, res, parsed);
			return;
		}
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
	}

	function asMetadataJson(res: ServerResponse, body: object): void {
		const payload = JSON.stringify(body);
		applyCors(res);
		res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }).end(
			payload,
		);
	}

	async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await readBody(req);
		let parsed: { redirect_uris?: string[]; client_name?: string; scope?: string } = {};
		try {
			parsed = body.length > 0 ? JSON.parse(body) : {};
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" }).end(
				JSON.stringify({ error: "invalid_request", error_description: "invalid JSON" }),
			);
			return;
		}
		if (!Array.isArray(parsed.redirect_uris) || parsed.redirect_uris.length === 0) {
			res.writeHead(400, { "Content-Type": "application/json" }).end(
				JSON.stringify({ error: "invalid_redirect_uri", error_description: "redirect_uris required" }),
			);
			return;
		}
		const newClientId = `dcr-${randomBytes(8).toString("base64url")}`;
		const newClientSecret = randomBytes(24).toString("base64url");
		registeredClients.set(newClientId, { clientSecret: newClientSecret });
		const out = {
			client_id: newClientId,
			client_secret: newClientSecret,
			client_id_issued_at: Math.floor(Date.now() / 1000),
			redirect_uris: parsed.redirect_uris,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "client_secret_basic",
			...(parsed.client_name ? { client_name: parsed.client_name } : {}),
			...(parsed.scope ? { scope: parsed.scope } : {}),
		};
		const payload = JSON.stringify(out);
		applyCors(res);
		res.writeHead(201, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }).end(
			payload,
		);
	}

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", baseUrl);
			if (
				req.method === "OPTIONS" &&
				(url.pathname === "/mcp" ||
					url.pathname === "/token" ||
					url.pathname === "/register" ||
					url.pathname.startsWith("/.well-known/"))
			) {
				applyCors(res);
				res.writeHead(204).end();
				return;
			}
			// RFC 9728 protected resource metadata — points discovery clients at this server as
			// both the resource AND the authorization server.
			if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
				asMetadataJson(res, {
					resource: `${baseUrl}/mcp`,
					authorization_servers: [baseUrl],
					scopes_supported: ["read", "write"],
				});
				return;
			}
			// RFC 8414 authorization server metadata.
			if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
				asMetadataJson(res, {
					issuer: baseUrl,
					authorization_endpoint: `${baseUrl}/authorize`,
					token_endpoint: `${baseUrl}/token`,
					registration_endpoint: `${baseUrl}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
					scopes_supported: ["read", "write"],
				});
				return;
			}
			// RFC 7591 Dynamic Client Registration.
			if (url.pathname === "/register" && req.method === "POST") {
				await handleRegister(req, res);
				return;
			}
			if (url.pathname === "/authorize" && req.method === "GET") {
				await handleAuthorize(req, res, url);
				return;
			}
			if (url.pathname === "/authorize/approve" && req.method === "POST") {
				await handleAuthorizeApprove(req, res, url);
				return;
			}
			if (url.pathname === "/token" && req.method === "POST") {
				applyCors(res);
				await handleToken(req, res);
				return;
			}
			if (url.pathname === "/mcp") {
				await handleMcp(req, res);
				return;
			}
			res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain" }).end(`oauth-mcp-server: ${message}`);
			}
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port, "127.0.0.1", () => resolve());
	});

	return {
		url: baseUrl,
		mcpUrl: `${baseUrl}/mcp`,
		authorizeUrl: `${baseUrl}/authorize`,
		tokenUrl: `${baseUrl}/token`,
		registrationEndpoint: `${baseUrl}/register`,
		clientId: defaultClientId,
		clientSecret: defaultClientSecret,
		uniqueBearerCount: () => seenBearers.size,
		registeredClientCount: () => registeredClients.size,
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
