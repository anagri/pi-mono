/**
 * sessionStorage-backed persistence of the current ACP sessionId, scoped per
 * browser tab. Cross-tab independence is intentional — each tab keeps its own
 * conversation alive across reloads, while a fresh tab starts a new session.
 *
 * The Dexie store (`@bodhiapp/bodhi-pi-browser/sessions`) holds the actual
 * session entries; this module only remembers WHICH session id this tab last
 * touched, so the runtime can call `session/load` on boot.
 */

const KEY = "bodhi-pi-web:sessionId";

export function readLastSessionId(): string | undefined {
	try {
		const v = sessionStorage.getItem(KEY);
		return v && v.length > 0 ? v : undefined;
	} catch {
		return undefined;
	}
}

export function writeLastSessionId(id: string): void {
	try {
		sessionStorage.setItem(KEY, id);
	} catch {
		// sessionStorage may be disabled (e.g. private mode quirks); fail silently.
	}
}

export function clearLastSessionId(): void {
	try {
		sessionStorage.removeItem(KEY);
	} catch {
		// ignore
	}
}
