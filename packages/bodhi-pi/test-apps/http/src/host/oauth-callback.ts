import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
	decodeTenantFromState,
	KvOAuthProvider,
	MCP_PREFIX,
	OAuthStateKv,
	parseMcpServerEntry,
	runAuthFlow,
} from "@bodhiapp/bodhi-pi";
import { createNodeKvStore } from "@bodhiapp/bodhi-pi-test-app-node-adapters";

export interface OauthCallbackOptions {
	dataDir: string;
}

/**
 * Handle `GET /oauth/callback?code=&state=` for the oauth flow. The state token
 * carries the routing tenant id (`<base64url(userId)>.<random>` per `decodeTenantFromState`),
 * so the handler can open the right user's kvStore without auth — the random suffix + 5-min
 * TTL on `OAuthStateKv` is the CSRF guard.
 *
 * Tokens persist to `mcp/<slug>.auth.tokens` on the user's kvStore. The next `_bodhi-pi/mcp/connect`
 * the user makes (via /acp or /acp-ws) reads them via the same `KvOAuthProvider`-driven attacher.
 * A lifecycle event is NOT emitted from this route — there's no live agent to emit through under
 * per-turn rebuild. Frontends can `mcpList()` after callback to confirm tokens or open a WS
 * connection and watch for tokens to appear via `mcp_status_change` on the next `mcp/connect`.
 */
export async function handleOauthCallback(
	req: IncomingMessage,
	res: ServerResponse,
	opts: OauthCallbackOptions,
): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		writeHtml(res, 400, "missing code or state");
		return;
	}
	const userId = decodeTenantFromState(state);
	if (!userId) {
		writeHtml(res, 400, "invalid state (no tenant prefix)");
		return;
	}

	const kvDir = path.join(opts.dataDir, "kv", userId);
	const kvStore = createNodeKvStore({ dir: kvDir });
	const stateKv = new OAuthStateKv(kvStore);

	const stateEntry = await stateKv.get(state);
	if (!stateEntry) {
		writeHtml(res, 400, "invalid or expired state");
		return;
	}

	const rawEntry = await kvStore.get(`${MCP_PREFIX}${stateEntry.slug}`);
	const entry = parseMcpServerEntry(rawEntry ?? null);
	if (!entry || entry.auth.mode !== "oauth") {
		writeHtml(res, 400, `mcp/${stateEntry.slug} is not configured for oauth`);
		return;
	}

	const provider = new KvOAuthProvider({
		kvStore,
		slug: stateEntry.slug,
		cfg: entry.auth,
		redirectUri: stateEntry.redirectUri,
		stateKv,
		state,
	});

	try {
		await runAuthFlow(provider, entry.auth.tokenUrl, code);
		await stateKv.remove(state);
		writeHtml(
			res,
			200,
			"<!doctype html><html><body><h2>OAuth complete</h2><p>You can close this window — bodhi-pi has saved your tokens.</p></body></html>",
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		writeHtml(res, 500, `<!doctype html><html><body>OAuth failed: ${escapeHtml(message)}</body></html>`);
	}
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
	);
}
