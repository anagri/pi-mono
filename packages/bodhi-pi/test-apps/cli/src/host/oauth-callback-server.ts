import { createServer, type Server } from "node:http";

export interface OAuthCallbackServerHandle {
	port: number;
	redirectUri: string;
	close(): Promise<void>;
}

export interface OAuthCallbackHandler {
	(params: { code: string; state: string }): Promise<void>;
}

export interface StartOAuthCallbackServerOptions {
	port: number;
	host?: string;
	path?: string;
	onCallback: OAuthCallbackHandler;
	timeoutMs?: number;
	onTimeout?: () => void;
}

/**
 * Tiny ephemeral HTTP server bound to `127.0.0.1:<port>` that handles a single OAuth redirect
 * (`GET <path>?code=&state=`), invokes `onCallback`, and tears itself down. Used by the CLI
 * host as the redirect target for the oauth-preregistered flow — the slash command boots it
 * before printing the authorize URL and shuts it down on receipt (or after `timeoutMs`).
 *
 * Multiple concurrent flows reuse one server when they target the same port: each callback is
 * routed by the `state` parameter on the URL, so the handler can dispatch to the right slug.
 */
export async function startOAuthCallbackServer(
	opts: StartOAuthCallbackServerOptions,
): Promise<OAuthCallbackServerHandle> {
	const host = opts.host ?? "127.0.0.1";
	const callbackPath = opts.path ?? "/callback";
	const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

	let closeServer: () => Promise<void>;
	let resolveClose: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => {
		resolveClose = resolve;
	});

	const server: Server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://${host}:${opts.port}`);
			if (url.pathname !== callbackPath) {
				res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (!code || !state) {
				res
					.writeHead(400, { "Content-Type": "text/plain" })
					.end("missing code or state");
				return;
			}
			res
				.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
				.end("<!doctype html><html><body>OAuth complete. You can close this window.</body></html>");
			try {
				await opts.onCallback({ code, state });
			} finally {
				// Tear down after the callback runs so any subsequent connection attempts immediately
				// see the closed port (and the host frees `:7777` for the next flow).
				await closeServer();
			}
		} catch (err) {
			if (!res.headersSent) {
				const message = err instanceof Error ? err.message : String(err);
				res.writeHead(500, { "Content-Type": "text/plain" }).end(`oauth-callback error: ${message}`);
			}
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
				reject(
					new Error(
						`OAuth callback port ${opts.port} in use; pass redirect_uri on /mcp add to choose a different port`,
					),
				);
			} else {
				reject(err);
			}
		});
		server.listen(opts.port, host, () => resolve());
	});

	const timer = setTimeout(() => {
		opts.onTimeout?.();
		void closeServer();
	}, timeoutMs);
	if (typeof timer.unref === "function") timer.unref();

	closeServer = async () => {
		clearTimeout(timer);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		resolveClose?.();
	};

	void closed;
	return {
		port: opts.port,
		redirectUri: `http://${host}:${opts.port}${callbackPath}`,
		close: () => closeServer(),
	};
}
