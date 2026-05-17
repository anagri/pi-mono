/**
 * Tiny module-level emitter shared between AppShell's event pump and the chat /mcp oauth slash.
 *
 * The slash command's completion path needs to fire from two independent runtime sources:
 *   1. The OAuth popup `postMessage`s `{kind: "bodhi-pi-oauth-callback", code, state}` back to
 *      `window.opener` (works for browser test-app where redirect_uri = `${origin}/oauth/callback`
 *      and the popup loads our React component).
 *   2. The HTTP/WS server's `/oauth/callback` route completes the flow server-side and emits
 *      `mcp_oauth_status_change` over the existing lifecycle event channel — no popup-to-opener
 *      messaging happens because the redirect_uri lands on a server-rendered HTML page, not our
 *      React tree. The slash needs to learn about completion via the lifecycle event channel.
 *
 * AppShell's `onEvent` callback already receives every BodhiPiEvent. It posts oauth-status events
 * to this bus; the slash command subscribes for the duration of one in-flight flow.
 */
export interface OauthStatusEvent {
	slug: string;
	status: "started" | "completed" | "failed" | "cancelled";
	errorMessage?: string;
}

type Listener = (event: OauthStatusEvent) => void;

const listeners = new Set<Listener>();

export function onOauthStatusEvent(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function emitOauthStatusEvent(event: OauthStatusEvent): void {
	for (const l of listeners) {
		try {
			l(event);
		} catch {
			// best-effort; one listener throwing must not block peers.
		}
	}
}
