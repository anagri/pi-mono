import { useEffect, useState } from "react";

/**
 * Standalone popup component rendered at `/oauth/callback`. Parses `?code=&state=` from the URL,
 * forwards them to `window.opener` via postMessage (target origin pinned to our own origin), and
 * closes itself. The opening tab's AppShell registers a `message` listener that picks this up and
 * forwards it to the Worker as `_bodhi-pi/mcp/oauth/finish`.
 *
 * Renders a tiny status line so a real user sees confirmation before the window closes.
 */
export function OAuthCallback() {
	const [status, setStatus] = useState<"forwarding" | "missing" | "no-opener">("forwarding");

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const code = params.get("code");
		const state = params.get("state");
		if (!code || !state) {
			setStatus("missing");
			return;
		}
		if (!window.opener) {
			setStatus("no-opener");
			return;
		}
		window.opener.postMessage(
			{ kind: "bodhi-pi-oauth-callback", code, state },
			window.location.origin,
		);
		// Give the opener a tick to receive the message before tearing down.
		const t = setTimeout(() => window.close(), 200);
		return () => clearTimeout(t);
	}, []);

	return (
		<div data-testid="oauth-callback" data-test-state={status} style={{ padding: 16, fontFamily: "sans-serif" }}>
			<h2>OAuth callback</h2>
			{status === "forwarding" && <p>Forwarding to bodhi-pi… you can close this window.</p>}
			{status === "missing" && <p>Missing `code` or `state` in URL.</p>}
			{status === "no-opener" && <p>No opener window to deliver to.</p>}
		</div>
	);
}
